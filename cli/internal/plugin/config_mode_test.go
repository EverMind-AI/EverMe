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

const testEvtToken = "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

// seedConfig writes body at mode and returns the path, so a case can
// start from a host-created config that is world-readable.
func seedConfig(t *testing.T, path, body string, mode os.FileMode) {
	t.Helper()
	require.NoError(t, os.WriteFile(path, []byte(body), mode))
	info, err := os.Stat(path)
	require.NoError(t, err)
	require.Equal(t, mode, info.Mode().Perm(), "seed must start from the mode under test")
}

// TestCommit_TightensWorldReadableTokenConfig is the regression for the
// 2026-08-17 review item 1.4.i. The config writers inherited the host's
// existing file mode so that installing would not "surprise the user by
// tightening their config". When the host created the file 0644 — Raven
// does, and ~/.raven/config.json was found world-readable in the wild —
// the freshly minted evt token landed in a file every local user can
// read. A file that stores a token must be 0600 no matter who created it.
func TestCommit_TightensWorldReadableTokenConfig(t *testing.T) {
	cases := []struct {
		name       string
		configName string
		seedBody   string
		newWriter  func() Writer
	}{
		{"raven", "config.json", "{}", func() Writer { return newRavenWriter() }},
		{"workbuddy", "mcp.json", "{}", func() Writer { return newWorkBuddyWriter() }},
		{"claude-desktop", "claude_desktop_config.json", "{}", func() Writer { return newClaudeDesktopWriter() }},
		{"openclaw", "openclaw.json", "{}", func() Writer { return newOpenClawWriter() }},
		{"opencode", "opencode.json", "{}", func() Writer { return newOpenCodeWriter() }},
		{"cursor", "mcp.json", "{}", func() Writer { return newCursorWriter() }},
		{"devin", "mcp.json", "{}", func() Writer { return newDevinWriter() }},
		{"codex", "config.toml", "", func() Writer { return newCodexWriter() }},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, tc.configName)
			seedConfig(t, path, tc.seedBody, 0o644)

			w := tc.newWriter()
			plan, err := w.Plan(context.Background(), path)
			require.NoError(t, err)
			_, err = w.Commit(context.Background(), plan, WriteParams{
				APIBaseURL: "https://api.everme.evermind.ai",
				AgentID:    "agt_" + tc.name,
				AgentToken: testEvtToken,
			})
			require.NoError(t, err)

			info, err := os.Stat(path)
			require.NoError(t, err)
			assert.Equal(t, os.FileMode(0o600), info.Mode().Perm(),
				"%s config stores the evt token and must not stay world-readable", tc.name)
		})
	}
}

// TestCommit_KeepsHostModeOnConfigWithoutToken pins the other half of the
// contract: only token-bearing files are force-tightened. Cursor's
// hooks.json holds command lines, not credentials, so a host that created
// it 0644 keeps 0644 — while the sibling mcp.json, which does carry the
// token, is tightened by the same Commit.
func TestCommit_KeepsHostModeOnConfigWithoutToken(t *testing.T) {
	dir := t.TempDir()
	mcpPath := filepath.Join(dir, "mcp.json")
	hooksPath := filepath.Join(dir, "hooks.json")
	seedConfig(t, mcpPath, "{}", 0o644)
	seedConfig(t, hooksPath, "{}", 0o644)

	w := newCursorWriter()
	plan, err := w.Plan(context.Background(), mcpPath)
	require.NoError(t, err)
	_, err = w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_cursor",
		AgentToken: testEvtToken,
	})
	require.NoError(t, err)

	mcpInfo, err := os.Stat(mcpPath)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), mcpInfo.Mode().Perm(), "mcp.json carries the token")

	hooksInfo, err := os.Stat(hooksPath)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o644), hooksInfo.Mode().Perm(), "hooks.json carries no credential")
}

// captureConfigNotices redirects the permission-notice writer for the
// duration of fn and returns what was written.
func captureConfigNotices(t *testing.T, fn func()) string {
	t.Helper()
	var buf strings.Builder
	orig := configNoticeWriter
	configNoticeWriter = &buf
	t.Cleanup(func() { configNoticeWriter = orig })
	fn()
	return buf.String()
}

// TestCommit_ExplainsWhyItTightenedTheConfig: changing the permissions of
// a file the user did not create is a surprise, so say it out loud once.
// Only when we actually narrow a group/other-readable file — a config
// that was already owner-only gets no noise.
func TestCommit_ExplainsWhyItTightenedTheConfig(t *testing.T) {
	commit := func(t *testing.T, path string) {
		t.Helper()
		w := newRavenWriter()
		plan, err := w.Plan(context.Background(), path)
		require.NoError(t, err)
		_, err = w.Commit(context.Background(), plan, WriteParams{
			APIBaseURL: "https://api.everme.evermind.ai",
			AgentID:    "agt_raven",
			AgentToken: testEvtToken,
		})
		require.NoError(t, err)
	}

	t.Run("world readable config is announced", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "config.json")
		seedConfig(t, path, "{}", 0o644)
		out := captureConfigNotices(t, func() { commit(t, path) })
		assert.Contains(t, out, path)
		assert.Contains(t, out, "0600")
		assert.NotContains(t, out, testEvtToken, "the notice must never quote the token")
	})

	t.Run("owner only config stays quiet", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "config.json")
		seedConfig(t, path, "{}", 0o600)
		out := captureConfigNotices(t, func() { commit(t, path) })
		assert.NotContains(t, out, "0600", "nothing changed, so say nothing")
	})
}
