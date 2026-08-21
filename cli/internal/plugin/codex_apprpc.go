// Package plugin — Codex app-server RPC transport.
//
// Codex CLI exposes a JSON-RPC-shaped protocol over stdio via
// `codex app-server --stdio`: newline-delimited JSON, requests carry an
// "id" and expect a matching `{"id","result"}` / `{"id","error"}` response,
// notifications omit "id" and expect none. The server also emits its own
// unsolicited notifications (observed live: `remoteControl/status/changed`)
// that must be skipped while a caller awaits a specific response id.
//
// codexRPCClient implements that wire protocol over an injected
// io.WriteCloser/io.Reader pair with zero exec.Cmd dependency, so it can be
// unit-tested with in-memory io.Pipe() pairs and a goroutine standing in for
// the app-server. codexAppServerProcess is the thin production wrapper that
// actually spawns the real `codex` binary.
//
// This whole transport exists to reach `hooks/list` and `config/batchWrite`
// (see codex_hook_trust.go), which are undocumented app-server RPCs, not a
// published API — Codex's own docs (https://learn.chatgpt.com/docs/hooks)
// describe only the interactive `/hooks` command for granting hook trust.
// OpenAI has an open feature request for a supported programmatic mechanism
// (https://github.com/openai/codex/issues/21615, filed 2026-05-07, still
// unresolved) that explicitly names this exact RPC dance as the unsupported
// workaround integrators currently rely on. Every failure here is therefore
// best-effort by design (see codexWriter.trustErr in codex.go) — a future
// Codex release changing or removing these RPCs must degrade to the manual
// `/hooks` fallback, not break the install.
package plugin

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
)

// codexAppServerRequestTimeout / codexAppServerCloseTimeout are `var`s (not
// `const`s) so tests can override them via the same save/restore-in-Cleanup
// pattern this package already uses for runtimeGOOSFn (runtime.go). App-server
// RPCs are local IPC against an already-spawned process, not a network fetch
// or a marketplace clone, so they warrant far shorter budgets than the 30s
// cmd.WaitDelay installCodexPlugin/upgradeCodexMarketplace use in codex.go.
var (
	codexAppServerRequestTimeout = 10 * time.Second
	codexAppServerCloseTimeout   = 1 * time.Second
)

// codexAppServerClient is the minimal surface codex_hook_trust.go's
// orchestration needs. Both codexRPCClient (real transport) and test fakes
// implement it, so the trust orchestration logic never needs a real
// subprocess to be unit-tested.
type codexAppServerClient interface {
	Request(ctx context.Context, method string, params interface{}) (json.RawMessage, error)
	Notify(method string, params interface{}) error
	Close() error
}

// codexRPCError is the JSON-RPC error shape: `{"id":N,"error":{"message":...}}`.
type codexRPCError struct {
	Message string `json:"message"`
}

func (e *codexRPCError) Error() string { return e.Message }

// codexRPCLine is the union of every shape a line from the app-server can
// take. A line with no "id" is a server-initiated notification and is
// dropped by the read loop rather than decoded further.
type codexRPCLine struct {
	ID     *int64          `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *codexRPCError  `json:"error"`
}

// codexRPCResult is what the read loop delivers to a waiting Request: either
// a decoded response line, or a transport-level failure (stdout closed
// before a response for this id ever arrived).
type codexRPCResult struct {
	line codexRPCLine
	err  error
}

// codexRPCClient implements codexAppServerClient over newline-delimited JSON
// on an injected io.WriteCloser (stdin) + io.Reader (stdout). It has zero
// exec.Cmd dependency, so unit tests drive it with in-memory io.Pipe() pairs
// and a goroutine standing in for the app-server — no subprocess, no shell,
// runs on every platform including Windows.
type codexRPCClient struct {
	stdin   io.WriteCloser
	writeMu sync.Mutex
	nextID  int64 // atomic

	pendingMu sync.Mutex
	pending   map[int64]chan codexRPCResult
	closed    bool // guarded by pendingMu; true once the read loop has exited

	closeOnce sync.Once
}

// newCodexRPCClient starts a background goroutine scanning stdout for
// newline-delimited JSON responses. It never blocks the caller and never
// exits on a single malformed or unsolicited line — only on stdout actually
// closing (subprocess exited, pipe closed), at which point every still
// pending Request fails immediately instead of waiting out its full timeout.
func newCodexRPCClient(stdin io.WriteCloser, stdout io.Reader) *codexRPCClient {
	c := &codexRPCClient{
		stdin:   stdin,
		pending: make(map[int64]chan codexRPCResult),
	}
	go c.readLoop(stdout)
	return c
}

func (c *codexRPCClient) readLoop(stdout io.Reader) {
	scanner := bufio.NewScanner(stdout)
	// hooks/list can list many hooks; the default 64KB token size is not a
	// safe assumption for that payload.
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var decoded codexRPCLine
		if err := json.Unmarshal(line, &decoded); err != nil {
			continue // never let one bad line kill the reader
		}
		if decoded.ID == nil {
			continue // unsolicited server notification, e.g. remoteControl/status/changed
		}
		c.deliver(*decoded.ID, codexRPCResult{line: decoded})
	}
	err := scanner.Err()
	if err == nil {
		err = io.EOF
	}
	c.failAllPending(fmt.Errorf("codex app-server stdout closed: %w", err))
}

func (c *codexRPCClient) deliver(id int64, result codexRPCResult) {
	c.pendingMu.Lock()
	ch, ok := c.pending[id]
	if ok {
		delete(c.pending, id)
	}
	c.pendingMu.Unlock()
	if ok {
		ch <- result
	}
}

func (c *codexRPCClient) failAllPending(err error) {
	c.pendingMu.Lock()
	pending := c.pending
	c.pending = make(map[int64]chan codexRPCResult)
	c.closed = true
	c.pendingMu.Unlock()
	for _, ch := range pending {
		ch <- codexRPCResult{err: err}
	}
}

// Request sends {"method","id","params"} and blocks until a matching
// response arrives, the request times out (codexAppServerRequestTimeout),
// or ctx is done. A JSON-RPC `error` field is surfaced as a Go error.
func (c *codexRPCClient) Request(ctx context.Context, method string, params interface{}) (json.RawMessage, error) {
	id := atomic.AddInt64(&c.nextID, 1)
	ch := make(chan codexRPCResult, 1)

	c.pendingMu.Lock()
	if c.closed {
		c.pendingMu.Unlock()
		return nil, fmt.Errorf("codex app-server connection is closed")
	}
	c.pending[id] = ch
	c.pendingMu.Unlock()

	if err := c.writeLine(map[string]interface{}{"method": method, "id": id, "params": params}); err != nil {
		c.pendingMu.Lock()
		delete(c.pending, id)
		c.pendingMu.Unlock()
		return nil, fmt.Errorf("write %s request: %w", method, err)
	}

	timer := time.NewTimer(codexAppServerRequestTimeout)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		c.pendingMu.Lock()
		delete(c.pending, id)
		c.pendingMu.Unlock()
		return nil, ctx.Err()
	case <-timer.C:
		c.pendingMu.Lock()
		delete(c.pending, id)
		c.pendingMu.Unlock()
		return nil, fmt.Errorf("codex app-server request timed out: %s", method)
	case result := <-ch:
		if result.err != nil {
			return nil, result.err
		}
		if result.line.Error != nil {
			return nil, fmt.Errorf("codex app-server rejected %s: %s", method, result.line.Error.Message)
		}
		return result.line.Result, nil
	}
}

// Notify sends {"method","params"} (no id) and returns as soon as the write
// completes — the app-server never responds to a notification.
func (c *codexRPCClient) Notify(method string, params interface{}) error {
	if err := c.writeLine(map[string]interface{}{"method": method, "params": params}); err != nil {
		return fmt.Errorf("write %s notification: %w", method, err)
	}
	return nil
}

func (c *codexRPCClient) writeLine(payload interface{}) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	body = append(body, '\n')
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err = c.stdin.Write(body)
	return err
}

// Close closes stdin. It never touches a process — that's
// codexAppServerProcess's job — so it's also what unit tests exercise
// directly against an io.Pipe() writer.
func (c *codexRPCClient) Close() error {
	var err error
	c.closeOnce.Do(func() {
		err = c.stdin.Close()
	})
	return err
}

// codexAppServerProcess pairs a codexRPCClient with the exec.Cmd that owns
// its pipes so Close() also reaps the subprocess: close stdin (which ends
// the app-server's stdio loop), wait up to codexAppServerCloseTimeout, then
// kill. Only this type — never codexRPCClient — depends on os/exec, keeping
// the wire protocol unit-testable without a subprocess.
type codexAppServerProcess struct {
	*codexRPCClient
	cmd    *exec.Cmd
	stderr *bytes.Buffer
}

func (p *codexAppServerProcess) Close() error {
	stdinErr := p.codexRPCClient.Close()

	done := make(chan error, 1)
	go func() { done <- p.cmd.Wait() }()

	select {
	case <-done:
	case <-time.After(codexAppServerCloseTimeout):
		_ = p.cmd.Process.Kill()
		<-done
	}
	return stdinErr
}

// Stderr returns a hint-sized tail of the process's captured stderr. Not
// part of codexAppServerClient — callers that want it (codex_hook_trust.go,
// to explain *why* automatic trust failed, e.g. an older Codex CLI printing
// "unknown subcommand app-server") type-assert for it, so test fakes that
// don't implement it are unaffected.
func (p *codexAppServerProcess) Stderr() string {
	return trimForHint(p.stderr.String())
}

// spawnCodexAppServer starts `codexExecutable app-server --stdio` and wires
// it to a codexRPCClient. cmd.WaitDelay mirrors the convention already used
// by installCodexPlugin/upgradeCodexMarketplace in codex.go.
func spawnCodexAppServer(ctx context.Context, codexExecutable string) (codexAppServerClient, error) {
	cmd := exec.CommandContext(ctx, codexExecutable, "app-server", "--stdio")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("open codex app-server stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("open codex app-server stdout: %w", err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	cmd.WaitDelay = codexAppServerCloseTimeout

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start codex app-server: %w", err)
	}

	return &codexAppServerProcess{
		codexRPCClient: newCodexRPCClient(stdin, stdout),
		cmd:            cmd,
		stderr:         &stderr,
	}, nil
}
