package plugin

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeCodexServer stands in for `codex app-server --stdio` over a pair of
// io.Pipe()s, so codexRPCClient's wire protocol is exercised with zero
// subprocess/shell dependency and runs on every platform including Windows.
type fakeCodexServer struct {
	t       *testing.T
	scanner *bufio.Scanner
	out     io.Writer
}

func newFakeCodexServer(t *testing.T, in io.Reader, out io.Writer) *fakeCodexServer {
	t.Helper()
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	return &fakeCodexServer{t: t, scanner: scanner, out: out}
}

// nextLine blocks for the next line written by the client, decoded into a
// generic map so tests can inspect "method"/"id"/"params" directly.
func (f *fakeCodexServer) nextLine() map[string]interface{} {
	f.t.Helper()
	if !f.scanner.Scan() {
		return nil
	}
	var decoded map[string]interface{}
	require.NoError(f.t, json.Unmarshal(f.scanner.Bytes(), &decoded))
	return decoded
}

func (f *fakeCodexServer) writeLine(v interface{}) {
	f.t.Helper()
	body, err := json.Marshal(v)
	require.NoError(f.t, err)
	body = append(body, '\n')
	_, err = f.out.Write(body)
	require.NoError(f.t, err)
}

func (f *fakeCodexServer) respond(id interface{}, result interface{}) {
	f.writeLine(map[string]interface{}{"id": id, "result": result})
}

// TestCodexRPCClient_Request_MatchesResponseByID proves responses are routed
// by "id", not by arrival order: two concurrent requests are answered in
// reverse of the order their lines were received.
func TestCodexRPCClient_Request_MatchesResponseByID(t *testing.T) {
	stdinR, stdinW := io.Pipe()
	stdoutR, stdoutW := io.Pipe()
	defer stdinW.Close()
	defer stdoutW.Close()

	server := newFakeCodexServer(t, stdinR, stdoutW)
	client := newCodexRPCClient(stdinW, stdoutR)

	type outcome struct {
		raw json.RawMessage
		err error
	}
	resultsA := make(chan outcome, 1)
	resultsB := make(chan outcome, 1)

	go func() {
		raw, err := client.Request(context.Background(), "callA", map[string]interface{}{"marker": "A"})
		resultsA <- outcome{raw, err}
	}()
	go func() {
		raw, err := client.Request(context.Background(), "callB", map[string]interface{}{"marker": "B"})
		resultsB <- outcome{raw, err}
	}()

	lines := []map[string]interface{}{server.nextLine(), server.nextLine()}
	for i := len(lines) - 1; i >= 0; i-- { // respond in reverse arrival order
		line := lines[i]
		params, _ := line["params"].(map[string]interface{})
		server.respond(line["id"], map[string]interface{}{"marker": params["marker"]})
	}

	a := <-resultsA
	require.NoError(t, a.err)
	assert.JSONEq(t, `{"marker":"A"}`, string(a.raw))

	b := <-resultsB
	require.NoError(t, b.err)
	assert.JSONEq(t, `{"marker":"B"}`, string(b.raw))
}

// TestCodexRPCClient_SkipsUnsolicitedNotifications mirrors the real observed
// shape: the app-server sends an id-less "remoteControl/status/changed"
// notification ahead of the actual response. It must not be mistaken for a
// response or wedge the pending request.
func TestCodexRPCClient_SkipsUnsolicitedNotifications(t *testing.T) {
	stdinR, stdinW := io.Pipe()
	stdoutR, stdoutW := io.Pipe()
	defer stdinW.Close()
	defer stdoutW.Close()

	server := newFakeCodexServer(t, stdinR, stdoutW)
	client := newCodexRPCClient(stdinW, stdoutR)

	type outcome struct {
		raw json.RawMessage
		err error
	}
	resultCh := make(chan outcome, 1)
	go func() {
		raw, err := client.Request(context.Background(), "hooks/list", nil)
		resultCh <- outcome{raw, err}
	}()

	line := server.nextLine()
	server.writeLine(map[string]interface{}{
		"method": "remoteControl/status/changed",
		"params": map[string]interface{}{"status": "disabled"},
	})
	server.respond(line["id"], map[string]interface{}{"data": []interface{}{}})

	got := <-resultCh
	require.NoError(t, got.err)
	assert.JSONEq(t, `{"data":[]}`, string(got.raw))
}

// TestCodexRPCClient_Notify_NoResponseExpected asserts Notify returns as
// soon as the write completes, without registering anything that could hang
// waiting for a response the app-server never sends to a notification.
func TestCodexRPCClient_Notify_NoResponseExpected(t *testing.T) {
	stdinR, stdinW := io.Pipe()
	stdoutR, stdoutW := io.Pipe()
	defer stdinW.Close()
	defer stdoutW.Close()

	server := newFakeCodexServer(t, stdinR, stdoutW)
	client := newCodexRPCClient(stdinW, stdoutR)

	// A real reader draining stdin: io.Pipe's Write blocks until something
	// Reads, so Notify's write only completes once this goroutine consumes
	// the line — which is exactly the "no response is ever awaited" behavior
	// under test, just without a synchronous reader on the main goroutine.
	lineCh := make(chan map[string]interface{}, 1)
	go func() { lineCh <- server.nextLine() }()

	done := make(chan error, 1)
	go func() { done <- client.Notify("initialized", struct{}{}) }()

	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(2 * time.Second):
		t.Fatal("Notify blocked as if awaiting a response")
	}

	var line map[string]interface{}
	select {
	case line = <-lineCh:
	case <-time.After(2 * time.Second):
		t.Fatal("notification line was never read")
	}
	_, hasID := line["id"]
	assert.False(t, hasID, "a notification must not carry an id")
	assert.Equal(t, "initialized", line["method"])
}

// TestCodexRPCClient_RequestError_SurfacesMessage asserts a JSON-RPC
// {"error":{"message"}} response becomes a Go error carrying that message.
func TestCodexRPCClient_RequestError_SurfacesMessage(t *testing.T) {
	stdinR, stdinW := io.Pipe()
	stdoutR, stdoutW := io.Pipe()
	defer stdinW.Close()
	defer stdoutW.Close()

	server := newFakeCodexServer(t, stdinR, stdoutW)
	client := newCodexRPCClient(stdinW, stdoutR)

	resultCh := make(chan error, 1)
	go func() {
		_, err := client.Request(context.Background(), "hooks/list", nil)
		resultCh <- err
	}()

	line := server.nextLine()
	server.writeLine(map[string]interface{}{
		"id":    line["id"],
		"error": map[string]interface{}{"message": "boom"},
	})

	err := <-resultCh
	require.Error(t, err)
	assert.Contains(t, err.Error(), "boom")
}

// TestCodexRPCClient_RequestTimeout overrides codexAppServerRequestTimeout
// (same save/restore-in-Cleanup convention as runtimeGOOSFn in runtime.go)
// so a server that never responds fails the request promptly.
func TestCodexRPCClient_RequestTimeout(t *testing.T) {
	prevTimeout := codexAppServerRequestTimeout
	codexAppServerRequestTimeout = 20 * time.Millisecond
	t.Cleanup(func() { codexAppServerRequestTimeout = prevTimeout })

	stdinR, stdinW := io.Pipe()
	stdoutR, stdoutW := io.Pipe()
	defer stdinW.Close()
	defer stdoutW.Close()

	// Drain stdin so the client's write doesn't block, but never respond.
	go func() {
		scanner := bufio.NewScanner(stdinR)
		for scanner.Scan() {
		}
	}()

	client := newCodexRPCClient(stdinW, stdoutR)
	_, err := client.Request(context.Background(), "hooks/list", nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "timed out")
}

// TestCodexRPCClient_StdoutClosed_FailsPendingRequests asserts a pending
// request fails as soon as stdout closes (subprocess exited), rather than
// waiting out the full request timeout. The drain goroutine signals once it
// has seen the request line, which happens-after the client registers the
// pending entry, so closing stdout at that point deterministically exercises
// the "pending request killed by EOF" path.
func TestCodexRPCClient_StdoutClosed_FailsPendingRequests(t *testing.T) {
	stdinR, stdinW := io.Pipe()
	stdoutR, stdoutW := io.Pipe()
	defer stdinW.Close()

	registered := make(chan struct{})
	go func() {
		scanner := bufio.NewScanner(stdinR)
		if scanner.Scan() {
			close(registered)
		}
		for scanner.Scan() {
		}
	}()

	client := newCodexRPCClient(stdinW, stdoutR)

	resultCh := make(chan error, 1)
	go func() {
		_, err := client.Request(context.Background(), "hooks/list", nil)
		resultCh <- err
	}()

	select {
	case <-registered:
	case <-time.After(2 * time.Second):
		t.Fatal("request was never written to stdin")
	}
	require.NoError(t, stdoutW.Close())

	select {
	case err := <-resultCh:
		require.Error(t, err)
		assert.Contains(t, err.Error(), "stdout closed")
	case <-time.After(2 * time.Second):
		t.Fatal("request did not fail promptly after stdout closed")
	}
}

// TestCodexRPCClient_Close_ClosesStdin asserts Close() closes stdin and is
// safe to call twice (sync.Once-guarded).
func TestCodexRPCClient_Close_ClosesStdin(t *testing.T) {
	stdinR, stdinW := io.Pipe()
	stdoutR, stdoutW := io.Pipe()
	defer stdoutW.Close()

	go func() {
		scanner := bufio.NewScanner(stdinR)
		for scanner.Scan() {
		}
	}()

	client := newCodexRPCClient(stdinW, stdoutR)
	require.NoError(t, client.Close())
	require.NoError(t, client.Close())

	_, err := stdinW.Write([]byte("x"))
	require.Error(t, err)
	assert.ErrorIs(t, err, io.ErrClosedPipe)
}
