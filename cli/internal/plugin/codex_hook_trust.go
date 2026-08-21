// Package plugin — Codex hook-trust orchestration.
//
// Codex CLI keeps every non-managed hook — including plugin-installed ones —
// in a "pending trust" state, gated by a per-hook content hash recorded in
// `[hooks.state]` in ~/.codex/config.toml, until something approves it: a
// human running `/hooks` inside a Codex session, or the same app-server RPC
// dance run programmatically. Without it, `evercli plugin install codex`
// "succeeds" but the EverMe lifecycle hooks it just installed never execute.
//
// codexEstablishHookTrust drives that RPC dance over codexAppServerClient
// (codex_apprpc.go): initialize -> initialized -> hooks/list -> (if any of
// the four EverMe hooks aren't already trusted) config/batchWrite ->
// hooks/list again to confirm the write took. It is Prepare's best-effort
// call — see codexWriter.trustErr in codex.go for why a failure here must
// never block token issuance.
//
// hooks/list and config/batchWrite are not a published Codex API — see the
// package doc on codex_apprpc.go for the upstream tracking issue
// (openai/codex#21615) confirming this is the only known way to grant
// trust programmatically today, and why every error path here is advisory.
package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"evercli/internal/output"
)

// codexExpectedHookEvents are the four lifecycle hooks EverMind-AI/EverMe's
// hooks/hooks.json declares. Discovering fewer than this many hooks under
// codexPluginSpec means the plugin install itself is broken (missing or
// corrupt hooks.json), not merely untrusted.
var codexExpectedHookEvents = []string{"sessionStart", "userPromptSubmit", "stop", "preCompact"}

// codexHookMetadata is the subset of the app-server's HookMetadata shape
// (confirmed live against codex-cli 0.147.0's `hooks/list`) this package
// needs. PluginID is nullable — only plugin-sourced hooks carry one.
type codexHookMetadata struct {
	Key         string  `json:"key"`
	EventName   string  `json:"eventName"`
	PluginID    *string `json:"pluginId"`
	CurrentHash string  `json:"currentHash"`
	TrustStatus string  `json:"trustStatus"`
}

type codexHooksListEntry struct {
	Hooks []codexHookMetadata `json:"hooks"`
}

type codexHooksListResult struct {
	Data []codexHooksListEntry `json:"data"`
}

// newCodexAppServerClientFn is the test seam for codexEstablishHookTrust,
// following the same var-for-override convention as runtimeGOOSFn
// (runtime.go): production wires the real subprocess, tests substitute a
// fake client with zero subprocess dependency.
var newCodexAppServerClientFn = spawnCodexAppServer

// codexStderrProvider is implemented by codexAppServerProcess (never by test
// fakes) so a process that started but behaved unexpectedly (e.g. an older
// Codex CLI without the app-server RPCs this needs) can have its stderr
// tail folded into the surfaced warning.
type codexStderrProvider interface{ Stderr() string }

// codexEstablishHookTrust is Prepare's best-effort entry point: spawn the
// Codex app-server, trust the four EverMe lifecycle hooks, tear the process
// down. Every failure is returned as a *output.CLIError with a Hint pointing
// at the manual `/hooks` fallback — callers must treat it as advisory, never
// fatal, per the file header comment above.
func codexEstablishHookTrust(ctx context.Context, codexExecutable string) error {
	client, err := newCodexAppServerClientFn(ctx, codexExecutable)
	if err != nil {
		return codexHookTrustErr("spawn", err)
	}

	trustErr := codexEstablishHookTrustWithClient(ctx, client)
	// Close before inspecting Stderr(): codexAppServerProcess.Close() waits
	// for the subprocess to exit, which is also what guarantees the
	// internal os/exec goroutine copying its stderr pipe into the buffer
	// has finished — reading it any earlier races with that copy.
	_ = client.Close()
	if trustErr == nil {
		return nil
	}
	if sp, ok := client.(codexStderrProvider); ok {
		if tail := sp.Stderr(); tail != "" {
			trustErr = fmt.Errorf("%w (codex app-server stderr: %s)", trustErr, tail)
		}
	}
	return codexHookTrustErr("trust", trustErr)
}

// codexEstablishHookTrustWithClient is the interface-testable core: given
// anything implementing codexAppServerClient, it runs the full
// initialize -> hooks/list -> [config/batchWrite -> hooks/list] sequence.
func codexEstablishHookTrustWithClient(ctx context.Context, client codexAppServerClient) error {
	if _, err := client.Request(ctx, "initialize", codexInitializeParams()); err != nil {
		return fmt.Errorf("initialize: %w", err)
	}
	if err := client.Notify("initialized", struct{}{}); err != nil {
		return fmt.Errorf("initialized: %w", err)
	}

	hooks, err := codexListEverMeHooks(ctx, client)
	if err != nil {
		return err
	}
	if codexAllHooksTrusted(hooks) {
		return nil
	}

	state := make(map[string]interface{}, len(hooks))
	for _, hook := range hooks {
		// Matches the real persisted TOML shape exactly (confirmed against a
		// live ~/.codex/config.toml): a hooks.state entry carries only
		// trusted_hash, no `enabled` field.
		state[hook.Key] = map[string]interface{}{"trusted_hash": hook.CurrentHash}
	}
	batchWriteParams := map[string]interface{}{
		"edits": []interface{}{
			map[string]interface{}{
				"keyPath":       "hooks.state",
				"mergeStrategy": "upsert",
				"value":         state,
			},
		},
		"reloadUserConfig": true,
	}
	if _, err := client.Request(ctx, "config/batchWrite", batchWriteParams); err != nil {
		return fmt.Errorf("config/batchWrite: %w", err)
	}

	verified, err := codexListEverMeHooks(ctx, client)
	if err != nil {
		return fmt.Errorf("re-verify after trust write: %w", err)
	}
	if !codexAllHooksTrusted(verified) {
		return fmt.Errorf("codex did not persist trust for all EverMe lifecycle hooks")
	}
	return nil
}

// codexListEverMeHooks calls hooks/list and returns exactly one
// codexHookMetadata per codexExpectedHookEvents entry, matched by
// pluginId == codexPluginSpec — simpler and more precise than matching by
// sourcePath+command, since plugin-sourced hooks carry a pluginId that
// user-level hooks don't. Errors naming whichever expected events are
// missing if Codex reports fewer than all four.
func codexListEverMeHooks(ctx context.Context, client codexAppServerClient) ([]codexHookMetadata, error) {
	raw, err := client.Request(ctx, "hooks/list", map[string]interface{}{"cwds": codexHooksListCwds()})
	if err != nil {
		return nil, fmt.Errorf("hooks/list: %w", err)
	}
	var result codexHooksListResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("hooks/list: parse response: %w", err)
	}

	byEvent := make(map[string]codexHookMetadata, len(codexExpectedHookEvents))
	for _, entry := range result.Data {
		for _, hook := range entry.Hooks {
			if hook.PluginID == nil || *hook.PluginID != codexPluginSpec {
				continue
			}
			byEvent[hook.EventName] = hook
		}
	}

	hooks := make([]codexHookMetadata, 0, len(codexExpectedHookEvents))
	var missing []string
	for _, event := range codexExpectedHookEvents {
		hook, ok := byEvent[event]
		if !ok {
			missing = append(missing, event)
			continue
		}
		hooks = append(hooks, hook)
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("codex did not report EverMe lifecycle hooks for: %s", strings.Join(missing, ", "))
	}
	return hooks, nil
}

// codexHooksListCwds resolves the `cwds` hooks/list param. Plugin-sourced
// hooks are not cwd-scoped (unlike project-level hooks.json entries), so any
// valid directory returns them; verified live against a real app-server.
func codexHooksListCwds() []string {
	if cwd, err := os.Getwd(); err == nil && cwd != "" {
		return []string{cwd}
	}
	return []string{}
}

func codexAllHooksTrusted(hooks []codexHookMetadata) bool {
	for _, hook := range hooks {
		if hook.TrustStatus != "trusted" {
			return false
		}
	}
	return true
}

func codexInitializeParams() map[string]interface{} {
	return map[string]interface{}{
		"clientInfo": map[string]interface{}{
			"name":    "evercli",
			"title":   "EverMe CLI",
			"version": "1",
		},
	}
}

// codexHookTrustErr wraps cause in the same output.IOErr shape codex.go's
// exec-based helpers use (e.g. installCodexPlugin's
// output.IOErr("codex plugin add", "exec", err)), with a Hint pointing at
// the manual /hooks fallback so a rendered warning is actionable on its own.
func codexHookTrustErr(op string, cause error) *output.CLIError {
	ce := output.IOErr("codex app-server", op, cause)
	ce.Hint = "EverMe's lifecycle hooks are installed but evercli could not auto-trust them automatically — this can happen on older Codex CLI releases that don't implement the hooks/list / config/batchWrite app-server RPCs. Start a new Codex session, open `/hooks`, and review and trust the EverMe hooks manually"
	return ce
}
