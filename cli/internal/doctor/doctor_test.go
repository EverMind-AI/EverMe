package doctor

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"evercli/internal/core"
	"evercli/internal/credential"
)

// fakeBackend is the smallest httptest server that satisfies the two
// remaining doctor checks: 200 on /healthz, 200 on /readyz. The
// envelope route the previous (deleted) authLoggedInCheck needed is
// no longer required.
func fakeBackend(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/healthz", "/readyz":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("ok"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestRun_NetworkAndCredHappyPath(t *testing.T) {
	srv := fakeBackend(t)
	tmp := t.TempDir()
	require.NoError(t, os.Chmod(tmp, 0o700))

	// Force the claude-code MCP-visibility check into its "no host"
	// branch so the test result is independent of whether the dev
	// machine running the suite happens to have `claude` on PATH.
	t.Setenv("EVERCLI_CLAUDE_CMD", "/nonexistent/claude-for-doctor-test")

	paths := &core.Paths{ConfigDir: tmp, DataDir: tmp, CacheDir: tmp}
	cfg := &core.Config{APIBaseURL: srv.URL, Paths: paths, Timeout: 5 * time.Second}

	prv := credential.NewMem()
	require.NoError(t, prv.Set(context.Background(), credential.APIKey(), "emk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))

	rep := Run(context.Background(), Deps{Config: cfg, CredPrv: prv})
	require.NotNil(t, rep)
	require.Len(t, rep.Checks, 5, "doctor runs: network.healthz, network.readyz, credential.backend, credential.readable, plugin.claude-code.mcp-visible")

	assert.Equal(t, "network.everme-api", rep.Checks[0].Name)
	assert.True(t, rep.Checks[0].OK)
	assert.Equal(t, "network.readyz", rep.Checks[1].Name)
	assert.True(t, rep.Checks[1].OK)
	assert.Equal(t, "credential.backend", rep.Checks[2].Name)
	assert.True(t, rep.Checks[2].OK)
	assert.Equal(t, "credential.readable", rep.Checks[3].Name)
	assert.True(t, rep.Checks[3].OK)
	assert.Equal(t, "plugin.claude-code.mcp-visible", rep.Checks[4].Name)
	assert.True(t, rep.Checks[4].OK, "with no claude CLI present the check degrades to SevInfo OK")
	assert.Equal(t, SevInfo, rep.Checks[4].Severity)

	assert.Zero(t, rep.Summary.CriticalFailed)
}

func TestRun_NetworkUnreachableMarksCritical(t *testing.T) {
	tmp := t.TempDir()
	require.NoError(t, os.Chmod(tmp, 0o700))

	paths := &core.Paths{ConfigDir: tmp, DataDir: tmp, CacheDir: tmp}
	// Point at a guaranteed-dead URL so /healthz fails fast.
	cfg := &core.Config{APIBaseURL: "http://127.0.0.1:1", Paths: paths, Timeout: 5 * time.Second}

	prv := credential.NewMem()

	rep := Run(context.Background(), Deps{Config: cfg, CredPrv: prv})
	require.NotNil(t, rep)
	assert.Equal(t, 1, rep.Summary.CriticalFailed,
		"healthz failure must surface as a single critical fail (readyz is warning-severity)")
}
