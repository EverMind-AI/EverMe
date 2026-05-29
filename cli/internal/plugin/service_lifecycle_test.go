package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"evercli/internal/client"
	"evercli/internal/credential"
	"evercli/internal/httpmock"
)

// Service-level integration tests for the lifecycle hooks (Preparer /
// Verifier) and the Verify-failure-as-Warning downgrade introduced in
// the Codex install work. The per-writer unit tests in codex_test.go
// only exercise w.Prepare / w.Verify in isolation — they do not prove
// that Service.installOne dispatches to them in the right order, nor
// that Prepare failures short-circuit before the backend mints a
// token, nor that Verify failures land on InstallEntry.Warnings
// instead of FailedEntry. A refactor breaking any of those invariants
// would pass the existing service_test.go suite but break production.
// This file pins those contracts.

// lifecycleStubWriter wraps the real *mcpWriter so Plan/Commit work
// against a t.TempDir() JSON file, and adds Preparer + Verifier hooks
// whose behaviour each test configures independently. Counters record
// whether each hook fired so we can assert call ordering against the
// httpmock request log.
type lifecycleStubWriter struct {
	inner        *mcpWriter
	prepareErr   error
	verifyErr    error
	prepareCount *int
	verifyCount  *int
}

func (w *lifecycleStubWriter) Platform() Platform { return w.inner.Platform() }

func (w *lifecycleStubWriter) Plan(ctx context.Context, configPath string) (*WritePlan, error) {
	return w.inner.Plan(ctx, configPath)
}

func (w *lifecycleStubWriter) Commit(ctx context.Context, plan *WritePlan, params WriteParams) (*WriteResult, error) {
	return w.inner.Commit(ctx, plan, params)
}

func (w *lifecycleStubWriter) Prepare(_ context.Context, _ *Detection) error {
	if w.prepareCount != nil {
		*w.prepareCount++
	}
	return w.prepareErr
}

func (w *lifecycleStubWriter) Verify(_ context.Context, _ *WriteResult) error {
	if w.verifyCount != nil {
		*w.verifyCount++
	}
	return w.verifyErr
}

// newLifecycleFixture wires a Service whose only platform is the
// lifecycleStubWriter on top of a real mcpWriter. configPath gets a
// fresh empty JSON object so Plan / Commit succeed unless the test
// arranges otherwise.
func newLifecycleFixture(t *testing.T, lwriter *lifecycleStubWriter) (*httpmock.Server, *Service, string) {
	t.Helper()
	tmp := t.TempDir()
	configPath := filepath.Join(tmp, "config.json")
	require.NoError(t, os.WriteFile(configPath, []byte(`{}`), 0o600))

	srv := httpmock.NewServer(t)
	mem := credential.NewMem()
	require.NoError(t, mem.Set(context.Background(), credential.APIKey(),
		"emk_0123456789abcdef0123456789abcdef"))
	cli := client.NewWithHTTP(srv.URL(), mem, srv.HTTPClient())

	platform := lwriter.Platform()
	reg := &registry{
		detectors: map[Platform]Detector{platform: stubDetector{
			platform: platform, display: string(platform), configPath: configPath, installed: true,
		}},
		writers: map[Platform]Writer{platform: lwriter},
	}
	svc := NewServiceWithRegistry(cli, reg, "https://api.test")
	svc.SetMachineFingerprintFn(func(_ Platform) string { return "test-fingerprint" })
	return srv, svc, configPath
}

// TestInstall_RunsPrepareBeforeRegisterAgent pins the ordering
// invariant from H.4 / service.go's wire-model comment: a Writer that
// implements Preparer must have Prepare() completed BEFORE the backend
// `POST /agents` call. We snapshot the prepare counter inside the
// /agents handler so a regression that reorders the lifecycle (e.g.
// "Prepare moves after RegisterAgent" via a refactor) fails the
// snapshot assertion even though Prepare still eventually runs.
func TestInstall_RunsPrepareBeforeRegisterAgent(t *testing.T) {
	prepareCount := 0
	verifyCount := 0
	lwriter := &lifecycleStubWriter{
		inner:        newMCPWriter(PlatformClaudeCode),
		prepareCount: &prepareCount,
		verifyCount:  &verifyCount,
	}
	srv, svc, _ := newLifecycleFixture(t, lwriter)

	prepareSeenAtRegister := -1
	srv.Handle("POST /agents", func(w http.ResponseWriter, _ *http.Request) {
		prepareSeenAtRegister = prepareCount
		envelope := map[string]any{
			"status":    0,
			"requestId": "req-mock",
			"result": client.RegisterAgentResp{
				AgentID: "agt_x", SourceID: "src_x",
				AgentToken: "evt_freshly_minted", TokenPrefix: "evt_a1b2",
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(envelope)
	})

	rep, err := svc.Install(context.Background(), []Platform{PlatformClaudeCode}, InstallOptions{}, nil)
	require.NoError(t, err)
	require.Empty(t, rep.Failed)
	require.Len(t, rep.Installed, 1)

	assert.Equal(t, 1, prepareCount, "Prepare must fire exactly once")
	assert.Equal(t, 1, verifyCount, "Verify must fire exactly once after Commit")
	assert.Equal(t, 1, prepareSeenAtRegister,
		"Prepare must complete before /agents fires — Prepare-failure-no-token-mint invariant depends on this ordering")
}

// TestInstall_PrepareFailure_DoesNotCallRegisterAgent pins the harder
// half of H.4: when Prepare fails, the backend must never see a
// /agents request. Otherwise we leak a stranded cloud token that
// outlives the local install attempt. Verify counter also asserted at
// zero — Verify is only meaningful after a successful Commit.
func TestInstall_PrepareFailure_DoesNotCallRegisterAgent(t *testing.T) {
	prepareCount := 0
	verifyCount := 0
	lwriter := &lifecycleStubWriter{
		inner:        newMCPWriter(PlatformClaudeCode),
		prepareErr:   errors.New("synthetic prepare failure (e.g. codex CLI missing)"),
		prepareCount: &prepareCount,
		verifyCount:  &verifyCount,
	}
	srv, svc, _ := newLifecycleFixture(t, lwriter)
	// Intentionally do NOT register a /agents handler. If installOne
	// reaches RegisterAgent, the request would 404 — but the explicit
	// LastRequest assertion below is the load-bearing proof.

	rep, err := svc.Install(context.Background(), []Platform{PlatformClaudeCode}, InstallOptions{}, nil)
	require.NoError(t, err)
	require.Len(t, rep.Failed, 1)
	assert.Empty(t, rep.Installed)
	assert.Contains(t, rep.Failed[0].Error.Message, "synthetic prepare failure")

	assert.Equal(t, 1, prepareCount, "Prepare must have run before failing")
	assert.Equal(t, 0, verifyCount, "Verify must not fire when Prepare failed")
	assert.Nil(t, srv.LastRequest("POST /agents"),
		"Prepare failure must short-circuit before backend rotation — otherwise we leak a stranded cloud token")
}

// TestInstall_VerifyFailure_DowngradesToWarning pins the post-Commit
// state-drift fix: a failing Verifier produces an InstallEntry with
// non-empty Warnings, NOT a FailedEntry. The token is on disk + on the
// server by this point; reporting "failed" would diverge the install
// report from runtime reality.
func TestInstall_VerifyFailure_DowngradesToWarning(t *testing.T) {
	lwriter := &lifecycleStubWriter{
		inner:     newMCPWriter(PlatformClaudeCode),
		verifyErr: errors.New("synthetic verify failure: section X missing after commit"),
	}
	srv, svc, configPath := newLifecycleFixture(t, lwriter)
	srv.HandleEnvelope("POST /agents", client.RegisterAgentResp{
		AgentID: "agt_verify_fail", SourceID: "src_x",
		AgentToken: "evt_freshly_minted", TokenPrefix: "evt_a1b2",
	})

	rep, err := svc.Install(context.Background(), []Platform{PlatformClaudeCode}, InstallOptions{}, nil)
	require.NoError(t, err)

	assert.Empty(t, rep.Failed, "Verify failure must NOT be reported as FailedEntry — token is already minted + on disk")
	require.Len(t, rep.Installed, 1, "Verify failure must still be reported as Installed (with Warnings)")
	entry := rep.Installed[0]
	assert.Equal(t, "agt_verify_fail", entry.AgentID, "successful Commit fields still populated")
	require.NotEmpty(t, entry.Warnings, "Verify failure must populate Warnings so doctor/JSON consumers see the half-failure")
	assert.Contains(t, entry.Warnings[0], "synthetic verify failure",
		"Warning must carry the underlying Verifier error message verbatim")
	assert.Contains(t, entry.Warnings[0], "evercli doctor",
		"Warning must guide the user to doctor for follow-up verification")

	// The freshly-minted token must still be in the config — Verify
	// failure does NOT rollback the local write (no .bak restore).
	raw, _ := os.ReadFile(configPath)
	var cfg map[string]any
	require.NoError(t, json.Unmarshal(raw, &cfg))
	env := cfg["mcpServers"].(map[string]any)["everme-memory"].(map[string]any)["env"].(map[string]any)
	assert.Equal(t, "evt_freshly_minted", env["EVERME_AGENT_TOKEN"],
		"Verify failure must not rollback the token — runtime stays consistent with the cloud-side rotation")
}

// TestInstall_DryRun_SkipsPrepareAndVerify pins that DryRun produces a
// preview without firing the side-effectful lifecycle hooks. Today
// installOne returns before reaching the Verify branch, but the
// Prepare branch has an explicit `!opts.DryRun` guard that this test
// catches if anyone removes.
func TestInstall_DryRun_SkipsPrepareAndVerify(t *testing.T) {
	prepareCount := 0
	verifyCount := 0
	lwriter := &lifecycleStubWriter{
		inner:        newMCPWriter(PlatformClaudeCode),
		prepareCount: &prepareCount,
		verifyCount:  &verifyCount,
	}
	srv, svc, _ := newLifecycleFixture(t, lwriter)

	rep, err := svc.Install(context.Background(), []Platform{PlatformClaudeCode}, InstallOptions{DryRun: true}, nil)
	require.NoError(t, err)
	require.Len(t, rep.Installed, 1, "DryRun must still produce a preview entry")
	assert.Equal(t, "agt_<dry-run>", rep.Installed[0].AgentID)

	assert.Equal(t, 0, prepareCount, "DryRun must not fire Prepare — its purpose is precisely to avoid side effects like marketplace add")
	assert.Equal(t, 0, verifyCount, "DryRun must not fire Verify — Commit never ran, so Verify has nothing to read back")
	assert.Nil(t, srv.LastRequest("POST /agents"),
		"DryRun must not touch the backend")
}
