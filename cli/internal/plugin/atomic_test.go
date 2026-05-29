package plugin

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestWriteFileAtomic_StaleTmpDoesNotLeakPerms is the regression for
// the security finding: os.WriteFile with O_CREATE|O_TRUNC keeps the
// existing perm bits on a pre-existing file. A crash that left a 0644
// .tmp behind would, on the next install, get truncated and rewritten
// at 0644 — embedding the freshly minted evt token in a world-readable
// file before the rename. writeFileAtomic now O_EXCLs onto a clean
// path, so the requested mode always sticks.
func TestWriteFileAtomic_StaleTmpDoesNotLeakPerms(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "everme.env")
	stale := path + ".tmp"
	// Simulate a previous-crash leftover: 0644 .tmp lingering on disk.
	require.NoError(t, os.WriteFile(stale, []byte("# stale\n"), 0o644))

	body := []byte("EVERME_AGENT_TOKEN=evt_secret_value\n")
	require.NoError(t, writeFileAtomic(path, body, 0o600))

	info, err := os.Stat(path)
	require.NoError(t, err)
	assert.EqualValues(t, 0o600, info.Mode().Perm(),
		"final file must carry the requested mode regardless of stale .tmp perms")

	// .tmp must not linger after the rename.
	_, statErr := os.Stat(stale)
	assert.True(t, os.IsNotExist(statErr),
		"writeFileAtomic must not leave a .tmp alongside the final file")

	// Content must be exactly what we wrote.
	got, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Equal(t, body, got)
}

// TestAssertNoConcurrentChange_DetectsEditAndCreate exercises both
// branches of the shared TOCTOU helper used by every Writer.Commit.
func TestAssertNoConcurrentChange_DetectsEditAndCreate(t *testing.T) {
	t.Run("edit_after_plan", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "config.json")
		require.NoError(t, os.WriteFile(path, []byte(`{"a":1}`), 0o600))
		info, _ := os.Stat(path)
		plan := &WritePlan{
			ConfigPath:      path,
			SnapshotModTime: info.ModTime().UnixNano(),
			SnapshotSize:    info.Size(),
		}
		// Concurrent edit shifts mtime and size.
		require.NoError(t, os.WriteFile(path, []byte(`{"a":1,"b":2}`), 0o600))

		err := assertNoConcurrentChange(plan)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "concurrent")
	})

	t.Run("create_after_plan", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "config.json")
		plan := &WritePlan{ConfigPath: path, WillCreate: true}
		require.NoError(t, os.WriteFile(path, []byte(`{"raced":true}`), 0o600))

		err := assertNoConcurrentChange(plan)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "concurrent")
	})

	t.Run("no_change_passes", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "config.json")
		require.NoError(t, os.WriteFile(path, []byte(`{"a":1}`), 0o600))
		info, _ := os.Stat(path)
		plan := &WritePlan{
			ConfigPath:      path,
			SnapshotModTime: info.ModTime().UnixNano(),
			SnapshotSize:    info.Size(),
		}
		assert.NoError(t, assertNoConcurrentChange(plan),
			"matching snapshot must pass the check")
	})
}

// TestClaudeCodeWriter_Plan_RespectsConfigPath verifies the writer
// honors the Writer interface's configPath parameter instead of always
// falling back to ~/.claude/everme.env.
func TestClaudeCodeWriter_Plan_RespectsConfigPath(t *testing.T) {
	dir := t.TempDir()
	customEnv := filepath.Join(dir, "custom-everme.env")
	require.NoError(t, os.WriteFile(customEnv, []byte("EVERME_AGENT_TOKEN=evt_old\n"), 0o600))

	t.Setenv("EVERCLI_CLAUDE_CMD", "true")
	t.Setenv("EVERCLI_CLAUDE_PLUGIN_SOURCE", dir)

	w := newClaudeCodeWriter()
	plan, err := w.Plan(t.Context(), customEnv)
	require.NoError(t, err)

	require.Equal(t, customEnv, plan.ConfigPath)
	require.True(t, plan.WillReplace)
	require.NotZero(t, plan.SnapshotModTime)
	require.NotZero(t, plan.SnapshotSize)
	assert.Equal(t, customEnv, plan.PreviewEntry["envFile"])
}

// TestClaudeCodeWriter_Commit_EnforcesTOCTOU proves the env-file
// writer now enforces the same C3 invariant as mcpWriter. We stub the
// claude CLI to a no-op so Commit doesn't actually shell out.
func TestClaudeCodeWriter_Commit_EnforcesTOCTOU(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, "everme.env")
	require.NoError(t, os.WriteFile(envPath, []byte("EVERME_AGENT_TOKEN=evt_old\n"), 0o600))

	// Stub the claude CLI to /usr/bin/true so the marketplace/install
	// shell-outs succeed without touching a real Claude Code install.
	t.Setenv("EVERCLI_CLAUDE_CMD", "true")
	t.Setenv("EVERCLI_CLAUDE_PLUGIN_SOURCE", dir) // any non-empty value

	w := newClaudeCodeWriter()
	// Plan via the writer's normal path, but pass our temp env file path
	// directly — the Plan implementation snapshots whichever path
	// envFilePath() resolves to. We override HOME so envFilePath lands in
	// our tmp dir.
	t.Setenv("HOME", dir)
	require.NoError(t, os.MkdirAll(filepath.Join(dir, ".claude"), 0o700))
	realEnv := filepath.Join(dir, ".claude", "everme.env")
	require.NoError(t, os.WriteFile(realEnv, []byte("EVERME_AGENT_TOKEN=evt_old\n"), 0o600))

	plan, err := w.Plan(t.Context(), "")
	require.NoError(t, err)
	require.Equal(t, realEnv, plan.ConfigPath)
	require.True(t, plan.WillReplace)
	require.NotZero(t, plan.SnapshotModTime, "Plan must capture mtime for TOCTOU")

	// Concurrent edit between Plan and Commit — must be refused.
	require.NoError(t, os.WriteFile(realEnv, []byte("EVERME_AGENT_TOKEN=evt_someone_else\n"), 0o600))

	_, err = w.Commit(t.Context(), plan, WriteParams{
		AgentID: "agt_x", AgentToken: "evt_NEW", APIBaseURL: "https://api.test",
	})
	require.Error(t, err)
	assert.True(t, strings.Contains(err.Error(), "concurrent"),
		"env-file Commit must refuse a concurrent-edit race")

	// Racer's content must NOT have been clobbered.
	got, _ := os.ReadFile(realEnv)
	assert.Contains(t, string(got), "evt_someone_else",
		"writer must preserve the racer's content")
}
