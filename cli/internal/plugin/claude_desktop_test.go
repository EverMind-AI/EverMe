package plugin

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestClaudeDesktopConfigPath_PerOS pins the per-OS layout. Anthropic's
// Claude Desktop writes to a different parent directory on each OS,
// and the installer matrix in docs/mcp-codex-hermes-iteration-plan-
// 2026-05-26.md treats all three cells as load-bearing. Use the
// runtimeGOOSFn indirection (not build tags) so the test runs on any
// CI host.
func TestClaudeDesktopConfigPath_PerOS(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	// Windows uses os.UserConfigDir() which prefers $APPDATA on Unix
	// hosts running the fake-GOOS branch — set it so the test result
	// is independent of whatever the runner's environment is.
	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming"))
	// Clear our test-only override so the OS branch is what's exercised.
	t.Setenv("EVERCLI_CLAUDE_DESKTOP_CONFIG_DIR", "")

	cases := []struct {
		goos         string
		wantContains []string
	}{
		{"darwin", []string{"Library", "Application Support", "Claude", "claude_desktop_config.json"}},
		{"windows", []string{"Claude", "claude_desktop_config.json"}},
		{"linux", []string{".config", "claude-desktop", "claude_desktop_config.json"}},
	}
	for _, tc := range cases {
		t.Run(tc.goos, func(t *testing.T) {
			prev := runtimeGOOSFn
			runtimeGOOSFn = func() string { return tc.goos }
			t.Cleanup(func() { runtimeGOOSFn = prev })

			got, err := claudeDesktopConfigPath()
			require.NoError(t, err)
			for _, frag := range tc.wantContains {
				assert.True(t, strings.Contains(got, frag),
					"path %q must contain %q for GOOS=%s", got, frag, tc.goos)
			}
		})
	}
}

func TestClaudeDesktopDetector_NoConfig_NotInstalled(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("EVERCLI_CLAUDE_DESKTOP_CONFIG_DIR", dir)
	t.Setenv("HOME", t.TempDir())

	d, err := claudeDesktopDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.Equal(t, PlatformClaudeDesktop, d.Platform)
	// Parent dir = the override dir we just created via t.TempDir(),
	// which DOES exist — Installed is "config parent dir exists",
	// matching how Claude Desktop creates the dir on first launch.
	assert.True(t, d.Installed)
	assert.False(t, d.ConfigExists)
	assert.False(t, d.HasEverMeEntry)
}

func TestClaudeDesktopDetector_ConfigWithEverMe_ReportsEntry(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("EVERCLI_CLAUDE_DESKTOP_CONFIG_DIR", dir)
	t.Setenv("HOME", t.TempDir())

	path := filepath.Join(dir, "claude_desktop_config.json")
	require.NoError(t, os.WriteFile(path, []byte(`{
      "mcpServers": {
        "everme-memory": {"command": "npx", "args": ["-y", "@everme/memory-mcp"]}
      }
    }`), 0o600))

	d, err := claudeDesktopDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.True(t, d.ConfigExists)
	assert.True(t, d.HasEverMeEntry)
}

// TestClaudeDesktopWriter_DoesNotImplementLifecycleInterfaces — see
// TestCursorWriter_DoesNotImplementLifecycleInterfaces for rationale.
// Both writers share the *mcpWriter concrete type, so we have to pin
// the negative on each independently — a future PR that only updates
// one detector test will still trip the other.
func TestClaudeDesktopWriter_DoesNotImplementLifecycleInterfaces(t *testing.T) {
	w := newClaudeDesktopWriter()
	_, isPreparer := any(w).(Preparer)
	assert.False(t, isPreparer, "claude-desktop writer must NOT implement Preparer — shared *mcpWriter type would activate Prepare for claude-code and cursor too")
	_, isVerifier := any(w).(Verifier)
	assert.False(t, isVerifier, "claude-desktop writer must NOT implement Verifier")
}

// TestClaudeDesktopWriter_UsesSharedMcpWriter mirrors the Cursor test —
// since both platforms route through mcpWriter, a single buildEntry
// change must reach Claude Desktop's emitted config unchanged.
func TestClaudeDesktopWriter_UsesSharedMcpWriter(t *testing.T) {
	w := newClaudeDesktopWriter()
	dir := t.TempDir()
	path := filepath.Join(dir, "claude_desktop_config.json")

	plan, err := w.Plan(context.Background(), path)
	require.NoError(t, err)

	_, err = w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_cd",
		AgentToken: "evt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	})
	require.NoError(t, err)

	got := readJSON(t, path)
	servers, ok := got["mcpServers"].(map[string]interface{})
	require.True(t, ok)
	entry, ok := servers["everme-memory"].(map[string]interface{})
	require.True(t, ok)
	env, _ := entry["env"].(map[string]interface{})
	assert.Equal(t, "agt_cd", env["EVERME_AGENT_ID"])
}
