package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"evercli/internal/output"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeCodexRPCStep pins one expected call in a fakeCodexAppServerClient's
// script: the method it must be, and what to hand back.
type fakeCodexRPCStep struct {
	wantMethod string
	result     json.RawMessage
	err        error
}

// fakeCodexAppServerClient is a strict ordered script: any call beyond the
// scripted steps, or one whose method doesn't match the next expected step,
// fails the test immediately. This also pins the exact fixed RPC sequence
// codexEstablishHookTrustWithClient issues, which the shell-stub integration
// test in codex_test.go depends on being deterministic.
type fakeCodexAppServerClient struct {
	t        *testing.T
	steps    []fakeCodexRPCStep
	notifies []string
	index    int
	closed   bool
}

func (f *fakeCodexAppServerClient) Request(_ context.Context, method string, _ interface{}) (json.RawMessage, error) {
	f.t.Helper()
	if f.index >= len(f.steps) {
		f.t.Fatalf("unexpected extra Request(%q): no more steps scripted", method)
	}
	step := f.steps[f.index]
	f.index++
	if step.wantMethod != method {
		f.t.Fatalf("Request #%d: want method %q, got %q", f.index, step.wantMethod, method)
	}
	return step.result, step.err
}

func (f *fakeCodexAppServerClient) Notify(method string, _ interface{}) error {
	f.notifies = append(f.notifies, method)
	return nil
}

func (f *fakeCodexAppServerClient) Close() error {
	f.closed = true
	return nil
}

// codexHookFixture builds one HookMetadata-shaped entry for tests.
// pluginID == "" produces a null pluginId (mirroring a non-plugin hook).
func codexHookFixture(event, pluginID, hash, trustStatus string) codexHookMetadata {
	var pid *string
	if pluginID != "" {
		pid = &pluginID
	}
	return codexHookMetadata{
		Key:         "everme@everme:hooks/hooks.json:" + event + ":0:0",
		EventName:   event,
		PluginID:    pid,
		CurrentHash: hash,
		TrustStatus: trustStatus,
	}
}

// codexAllExpectedHooks builds one fixture per codexExpectedHookEvents entry
// under codexPluginSpec, all with the same trustStatus.
func codexAllExpectedHooks(trustStatus string) []codexHookMetadata {
	hooks := make([]codexHookMetadata, 0, len(codexExpectedHookEvents))
	for i, event := range codexExpectedHookEvents {
		hooks = append(hooks, codexHookFixture(event, codexPluginSpec, fmt.Sprintf("sha256:%d", i), trustStatus))
	}
	return hooks
}

func codexHooksListResultJSON(t *testing.T, hooks ...codexHookMetadata) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(codexHooksListResult{Data: []codexHooksListEntry{{Hooks: hooks}}})
	require.NoError(t, err)
	return raw
}

func TestCodexEstablishHookTrust_AlreadyTrusted_SkipsWrite(t *testing.T) {
	client := &fakeCodexAppServerClient{
		t: t,
		steps: []fakeCodexRPCStep{
			{wantMethod: "initialize", result: json.RawMessage(`{}`)},
			{wantMethod: "hooks/list", result: codexHooksListResultJSON(t, codexAllExpectedHooks("trusted")...)},
		},
	}

	err := codexEstablishHookTrustWithClient(context.Background(), client)

	require.NoError(t, err)
	assert.Equal(t, 2, client.index, "must not call config/batchWrite or re-verify once already trusted")
	assert.Equal(t, []string{"initialized"}, client.notifies)
}

func TestCodexEstablishHookTrust_NeedsTrust_UpsertsAndReverifies(t *testing.T) {
	needsTrust := codexAllExpectedHooks("untrusted")
	needsTrust[1].TrustStatus = "modified" // e.g. after a plugin version bump changed currentHash

	client := &fakeCodexAppServerClient{
		t: t,
		steps: []fakeCodexRPCStep{
			{wantMethod: "initialize", result: json.RawMessage(`{}`)},
			{wantMethod: "hooks/list", result: codexHooksListResultJSON(t, needsTrust...)},
			{wantMethod: "config/batchWrite", result: json.RawMessage(`{}`)},
			{wantMethod: "hooks/list", result: codexHooksListResultJSON(t, codexAllExpectedHooks("trusted")...)},
		},
	}

	err := codexEstablishHookTrustWithClient(context.Background(), client)

	require.NoError(t, err)
	assert.Equal(t, 4, client.index, "untrusted/modified hooks must trigger the full write-then-reverify sequence")
}

func TestCodexEstablishHookTrust_IgnoresHooksFromOtherSources(t *testing.T) {
	hooks := codexAllExpectedHooks("trusted")
	// Same event name as one of ours, but not our plugin — must not shadow
	// the real everme entry in the by-event lookup.
	hooks = append(hooks,
		codexHookFixture("stop", "", "sha256:no-plugin", "untrusted"),
		codexHookFixture("stop", "other@marketplace", "sha256:other-plugin", "untrusted"),
	)

	client := &fakeCodexAppServerClient{
		t: t,
		steps: []fakeCodexRPCStep{
			{wantMethod: "initialize", result: json.RawMessage(`{}`)},
			{wantMethod: "hooks/list", result: codexHooksListResultJSON(t, hooks...)},
		},
	}

	err := codexEstablishHookTrustWithClient(context.Background(), client)

	require.NoError(t, err)
	assert.Equal(t, 2, client.index, "unrelated hooks must not trigger a write")
}

func TestCodexEstablishHookTrust_MissingHooks_Errors(t *testing.T) {
	hooks := codexAllExpectedHooks("trusted")
	hooks = hooks[:len(hooks)-1] // drop the last expected event (preCompact)

	client := &fakeCodexAppServerClient{
		t: t,
		steps: []fakeCodexRPCStep{
			{wantMethod: "initialize", result: json.RawMessage(`{}`)},
			{wantMethod: "hooks/list", result: codexHooksListResultJSON(t, hooks...)},
		},
	}

	err := codexEstablishHookTrustWithClient(context.Background(), client)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "preCompact")
	assert.Equal(t, 2, client.index, "config/batchWrite must never be reached when a hook is missing")
}

func TestCodexEstablishHookTrust_ReverifyStillUntrusted_Errors(t *testing.T) {
	needsTrust := codexAllExpectedHooks("untrusted")
	stillUntrusted := codexAllExpectedHooks("trusted")
	stillUntrusted[0].TrustStatus = "untrusted"

	client := &fakeCodexAppServerClient{
		t: t,
		steps: []fakeCodexRPCStep{
			{wantMethod: "initialize", result: json.RawMessage(`{}`)},
			{wantMethod: "hooks/list", result: codexHooksListResultJSON(t, needsTrust...)},
			{wantMethod: "config/batchWrite", result: json.RawMessage(`{}`)},
			{wantMethod: "hooks/list", result: codexHooksListResultJSON(t, stillUntrusted...)},
		},
	}

	err := codexEstablishHookTrustWithClient(context.Background(), client)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "did not persist trust")
}

func TestCodexEstablishHookTrust_InitializeFails_Errors(t *testing.T) {
	client := &fakeCodexAppServerClient{
		t: t,
		steps: []fakeCodexRPCStep{
			{wantMethod: "initialize", err: errors.New("boom")},
		},
	}

	err := codexEstablishHookTrustWithClient(context.Background(), client)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "initialize:")
	assert.Contains(t, err.Error(), "boom")
}

func TestCodexEstablishHookTrust_ClosesClientEvenOnError(t *testing.T) {
	fake := &fakeCodexAppServerClient{
		t: t,
		steps: []fakeCodexRPCStep{
			{wantMethod: "initialize", err: errors.New("boom")},
		},
	}
	prev := newCodexAppServerClientFn
	newCodexAppServerClientFn = func(context.Context, string) (codexAppServerClient, error) { return fake, nil }
	t.Cleanup(func() { newCodexAppServerClientFn = prev })

	err := codexEstablishHookTrust(context.Background(), "codex")

	require.Error(t, err)
	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Contains(t, ce.Hint, "/hooks")
	assert.True(t, fake.closed, "client must be closed even when the trust sequence errors")
}

func TestCodexEstablishHookTrust_SpawnFails_WrapsError(t *testing.T) {
	prev := newCodexAppServerClientFn
	newCodexAppServerClientFn = func(context.Context, string) (codexAppServerClient, error) {
		return nil, errors.New("no such binary")
	}
	t.Cleanup(func() { newCodexAppServerClientFn = prev })

	err := codexEstablishHookTrust(context.Background(), "codex")

	require.Error(t, err)
	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Equal(t, "spawn", ce.Detail["op"])
	assert.Contains(t, ce.Hint, "/hooks")
}
