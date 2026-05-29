// Package doctor implements `evercli doctor` self-checks.
//
// Scope is intentionally minimal: just the two checks an operator
// actually needs at "is anything obviously broken" triage time —
// network reachability and credential-backend health. Deeper
// diagnostics (plugin detection, checkpoint state, login validation,
// cleanup of stale artifacts) used to live here but were retired in
// the slimming pass; the data is reconstructable via `evercli auth
// status / plugin list / import run --resume` so duplicating it as
// doctor checks gave the doctor command a sprawling surface for
// little marginal value.
package doctor

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"time"

	"evercli/internal/client"
	"evercli/internal/core"
	"evercli/internal/credential"
	"evercli/internal/plugin"
)

// Severity orders checks for output and exit-code rules:
//   - Critical fail → exit 1
//   - Warning  fail → exit 0 but visibly flagged
//   - Info     fail → exit 0 (used for diagnostic context only)
type Severity string

const (
	SevCritical Severity = "critical"
	SevWarning  Severity = "warning"
	SevInfo     Severity = "info"
)

// Result is what every Check returns. Detail is freeform for structured
// JSON consumption; HintCmd is the suggested next-step user command.
type Result struct {
	Name      string                 `json:"name"`
	Severity  Severity               `json:"severity"`
	OK        bool                   `json:"ok"`
	Message   string                 `json:"message"`
	Detail    map[string]interface{} `json:"detail,omitempty"`
	HintCmd   string                 `json:"hintCmd,omitempty"`
	LatencyMs int64                  `json:"latencyMs,omitempty"`
}

// Check is the per-diagnostic interface.
type Check interface {
	Run(ctx context.Context) Result
}

// Report is the doctor envelope: per-check rows plus a summary.
type Report struct {
	Checks  []Result `json:"checks"`
	Summary Summary  `json:"summary"`
}

// Summary is the headline tally consumers (and the exit-code logic) read.
type Summary struct {
	CriticalFailed int `json:"criticalFailed"`
	WarningFailed  int `json:"warningFailed"`
}

// Deps is what the runner (and individual checks) need from the cmd
// layer.
type Deps struct {
	Config  *core.Config
	Client  client.Client
	CredPrv credential.Provider
}

// Run executes the slim MVP check set: connectivity (healthz / readyz)
// and credential backend health. Checks fan out across goroutines so
// the wall-clock cost is the slowest individual check rather than the
// sum of all of them. Output order matches declaration order so the
// human-format renderer stays predictable.
func Run(ctx context.Context, d Deps) *Report {
	checks := []Check{
		networkCheck{baseURL: d.Config.APIBaseURL, path: "/healthz", name: "network.everme-api", sev: SevCritical},
		networkCheck{baseURL: d.Config.APIBaseURL, path: "/readyz", name: "network.readyz", sev: SevWarning},
		credBackendCheck{prv: d.CredPrv},
		credReadableCheck{prv: d.CredPrv},
		claudeCodeMcpVisibleCheck{},
	}

	results := make([]Result, len(checks))
	var wg sync.WaitGroup
	wg.Add(len(checks))
	for i, c := range checks {
		i, c := i, c
		go func() {
			defer wg.Done()
			results[i] = c.Run(ctx)
		}()
	}

	// Wait for either all checks or ctx cancellation. Without this
	// branch a Ctrl-C had to wait for the slowest check's per-call
	// timeout (often 5s+) before the report could be emitted; now we
	// return whatever we have, marking unfinished rows as "cancelled".
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
		// Don't drain wg here — checks may take additional time to
		// notice ctx cancellation and we'd rather give the user back
		// control than block. Goroutines complete on their own.
	}

	rep := &Report{}
	for i, r := range results {
		// Synthesize a placeholder for checks that didn't complete
		// before ctx was cancelled. Without this an unfinished slot
		// renders as the zero-value Result (empty Name) which is more
		// confusing than "cancelled" in the human-format output.
		if r.Name == "" && ctx.Err() != nil {
			r = Result{
				Name:     fmt.Sprintf("check[%d]", i),
				Severity: SevInfo,
				OK:       false,
				Message:  "cancelled before completion",
			}
		}
		rep.Checks = append(rep.Checks, r)
		if !r.OK {
			switch r.Severity {
			case SevCritical:
				rep.Summary.CriticalFailed++
			case SevWarning:
				rep.Summary.WarningFailed++
			}
		}
	}
	return rep
}

// ---- individual checks ----------------------------------------------

type networkCheck struct {
	baseURL string
	path    string
	name    string
	sev     Severity
}

func (n networkCheck) Run(ctx context.Context) Result {
	r := Result{Name: n.name, Severity: n.sev, OK: false}
	if n.baseURL == "" {
		r.Message = "no API base URL configured"
		return r
	}
	url := strings.TrimRight(n.baseURL, "/") + n.path
	cli := &http.Client{Timeout: 5 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		r.Message = err.Error()
		return r
	}
	t0 := time.Now()
	resp, err := cli.Do(req)
	r.LatencyMs = time.Since(t0).Milliseconds()
	if err != nil {
		r.Message = "unreachable: " + err.Error()
		return r
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		r.OK = true
		r.Message = "reachable"
		return r
	}
	r.Message = fmt.Sprintf("HTTP %d", resp.StatusCode)
	return r
}

type credBackendCheck struct{ prv credential.Provider }

func (c credBackendCheck) Run(_ context.Context) Result {
	name := ""
	if c.prv != nil {
		name = c.prv.Name()
	}
	return Result{
		Name: "credential.backend", Severity: SevInfo, OK: name != "",
		Message: "using " + name,
		Detail:  map[string]interface{}{"name": name},
	}
}

// claudeCodeMcpVisibleCheck probes whether the bundled MCP server of
// the @everme/claude-code plugin is visible to Claude Code via
// `claude mcp list`. This is the silent-failure mode we hit before:
// `claude plugin install` exits 0 (plugin registered, hooks work), but
// the plugin's MCP server is gated by a separate user-consent step
// (`/mcp` inside Claude Code → enabledMcpjsonServers). Without this
// check, the symptom — manual tool calls like everme_search not
// appearing — looks like a backend issue and takes far longer to
// localize than it should.
//
// SevWarning, not Critical: hooks-only operation is a legitimate
// configuration. We only flag the gap so the user knows it exists.
type claudeCodeMcpVisibleCheck struct{}

func (claudeCodeMcpVisibleCheck) Run(ctx context.Context) Result {
	r := Result{Name: "plugin.claude-code.mcp-visible", Severity: SevWarning}
	visible, err := plugin.ClaudeMcpListContainsEverme(ctx)
	if err != nil {
		// exec.LookPath returns ErrNotFound for bare-name PATH misses
		// and fs.ErrNotExist for absolute paths that don't exist on
		// disk (the EVERCLI_CLAUDE_CMD test-override shape). Both
		// mean "no Claude Code on this host" — skip cleanly rather
		// than warn. evercli is host-agnostic; absence of one host
		// isn't a doctor failure.
		if errors.Is(err, exec.ErrNotFound) || errors.Is(err, fs.ErrNotExist) {
			r.Severity = SevInfo
			r.OK = true
			r.Message = "claude CLI not on PATH; skipped"
			return r
		}
		r.Message = "could not query `claude mcp list`: " + err.Error()
		r.HintCmd = "claude mcp list"
		return r
	}
	if visible {
		r.OK = true
		r.Message = "everme MCP server visible to Claude Code"
		return r
	}
	r.Message = "plugin installed but its MCP server isn't approved yet"
	r.HintCmd = "open Claude Code → /mcp → approve `everme`"
	return r
}

type credReadableCheck struct{ prv credential.Provider }

func (c credReadableCheck) Run(ctx context.Context) Result {
	r := Result{Name: "credential.readable", Severity: SevCritical}
	if c.prv == nil {
		r.Message = "no credential provider"
		return r
	}
	_, err := c.prv.Get(ctx, credential.APIKey())
	if errors.Is(err, credential.ErrNotFound) {
		// Not logged in is not a credential-backend failure; the user
		// gets that signal from `evercli auth status`. Treat as OK so
		// `doctor` only fires when the backend itself is broken.
		r.OK = true
		r.Message = "backend reachable (no credential set)"
		return r
	}
	if err != nil {
		r.Message = err.Error()
		return r
	}
	r.OK = true
	r.Message = "credential present and readable"
	return r
}
