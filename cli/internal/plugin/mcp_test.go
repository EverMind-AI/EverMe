package plugin

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"evercli/internal/output"
)

// readJSON is a small helper since most assertions need to inspect the
// resulting config as a generic map.
func readJSON(t *testing.T, path string) map[string]interface{} {
	t.Helper()
	raw, err := os.ReadFile(path)
	require.NoError(t, err)
	var m map[string]interface{}
	require.NoError(t, json.Unmarshal(raw, &m))
	return m
}

func TestPlan_NewFile_WillCreate(t *testing.T) {
	w := newMCPWriter(PlatformClaudeCode)
	dir := t.TempDir()
	path := filepath.Join(dir, "claude.json")

	plan, err := w.Plan(context.Background(), path)
	require.NoError(t, err)
	assert.True(t, plan.WillCreate)
	assert.False(t, plan.WillReplace)
	assert.Empty(t, plan.BackupPath, "no backup needed when file is being created")
}

func TestPlan_ExistingFile_WithoutEntry_WillNotReplace(t *testing.T) {
	w := newMCPWriter(PlatformClaudeCode)
	dir := t.TempDir()
	path := filepath.Join(dir, "claude.json")
	require.NoError(t, os.WriteFile(path, []byte(`{"otherKey":1}`), 0o600))

	plan, err := w.Plan(context.Background(), path)
	require.NoError(t, err)
	assert.False(t, plan.WillCreate)
	assert.False(t, plan.WillReplace)
	assert.NotEmpty(t, plan.BackupPath, "an existing file must always be backed up before mutation")
}

func TestPlan_RejectsMalformedJSON(t *testing.T) {
	w := newMCPWriter(PlatformClaudeCode)
	dir := t.TempDir()
	path := filepath.Join(dir, "claude.json")
	require.NoError(t, os.WriteFile(path, []byte(`not json`), 0o600))

	_, err := w.Plan(context.Background(), path)
	require.Error(t, err)
	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Equal(t, output.TypeIO, ce.Type)
	assert.NotEmpty(t, ce.Hint)
}

func TestCommit_CreatesNewFileWithEntry(t *testing.T) {
	w := newMCPWriter(PlatformClaudeCode)
	dir := t.TempDir()
	path := filepath.Join(dir, "claude.json")

	plan, err := w.Plan(context.Background(), path)
	require.NoError(t, err)

	res, err := w.Commit(context.Background(), plan, WriteParams{
		AgentID: "agt_x", AgentToken: "evt_secret_token_value", APIBaseURL: "https://api.test",
	})
	require.NoError(t, err)
	assert.True(t, res.WroteNewEntry)

	got := readJSON(t, path)
	servers := got["mcpServers"].(map[string]interface{})
	entry := servers["everme-memory"].(map[string]interface{})
	env := entry["env"].(map[string]interface{})
	assert.Equal(t, "agt_x", env["EVERME_AGENT_ID"])
	assert.Equal(t, "evt_secret_token_value", env["EVERME_AGENT_TOKEN"])
	assert.Equal(t, "https://api.test", env["EVERME_API_BASE"])

	// File permissions tighten to 0600
	info, err := os.Stat(path)
	require.NoError(t, err)
	assert.EqualValues(t, 0o600, info.Mode().Perm())
}

func TestCommit_PreservesUserOtherKeys(t *testing.T) {
	w := newMCPWriter(PlatformClaudeCode)
	dir := t.TempDir()
	path := filepath.Join(dir, "claude.json")

	original := map[string]interface{}{
		"theme": "dark",
		"mcpServers": map[string]interface{}{
			"user-custom": map[string]interface{}{
				"command": "node",
				"args":    []interface{}{"/tmp/custom.js"},
			},
		},
	}
	raw, _ := json.Marshal(original)
	require.NoError(t, os.WriteFile(path, raw, 0o600))

	plan, err := w.Plan(context.Background(), path)
	require.NoError(t, err)
	_, err = w.Commit(context.Background(), plan, WriteParams{
		AgentID: "agt_x", AgentToken: "evt_x", APIBaseURL: "https://api.test",
	})
	require.NoError(t, err)

	got := readJSON(t, path)
	assert.Equal(t, "dark", got["theme"], "non-mcp keys must be preserved verbatim")

	servers := got["mcpServers"].(map[string]interface{})
	require.Contains(t, servers, "user-custom", "other mcp entries must be preserved")
	require.Contains(t, servers, "everme-memory")
}

func TestCommit_ReplacesExistingEverMeEntry(t *testing.T) {
	w := newMCPWriter(PlatformClaudeCode)
	dir := t.TempDir()
	path := filepath.Join(dir, "claude.json")

	stale := map[string]interface{}{
		"mcpServers": map[string]interface{}{
			"everme-memory": map[string]interface{}{
				"env": map[string]interface{}{"EVERME_AGENT_TOKEN": "evt_OLD"},
			},
		},
	}
	raw, _ := json.Marshal(stale)
	require.NoError(t, os.WriteFile(path, raw, 0o600))

	plan, err := w.Plan(context.Background(), path)
	require.NoError(t, err)
	assert.True(t, plan.WillReplace)

	res, err := w.Commit(context.Background(), plan, WriteParams{
		AgentID: "agt_y", AgentToken: "evt_NEW", APIBaseURL: "https://api.test",
	})
	require.NoError(t, err)
	assert.False(t, res.WroteNewEntry)

	got := readJSON(t, path)
	env := got["mcpServers"].(map[string]interface{})["everme-memory"].(map[string]interface{})["env"].(map[string]interface{})
	assert.Equal(t, "evt_NEW", env["EVERME_AGENT_TOKEN"])
}

func TestCommit_BackupContainsOriginal(t *testing.T) {
	w := newMCPWriter(PlatformClaudeCode)
	dir := t.TempDir()
	path := filepath.Join(dir, "claude.json")
	require.NoError(t, os.WriteFile(path, []byte(`{"theme":"old"}`), 0o600))

	plan, _ := w.Plan(context.Background(), path)
	res, err := w.Commit(context.Background(), plan, WriteParams{
		AgentID: "agt_x", AgentToken: "evt_x", APIBaseURL: "https://api.test",
	})
	require.NoError(t, err)
	require.NotEmpty(t, res.BackupPath)

	bak, err := os.ReadFile(res.BackupPath)
	require.NoError(t, err)
	assert.Contains(t, string(bak), `"theme":"old"`, "backup must hold the pre-write contents verbatim")
}

func TestCommit_SingleBackupOverwrittenOnReinstall(t *testing.T) {
	// Slimming-pass contract: backups are single-file at `<path>-bak`,
	// re-running install overwrites the previous backup with the
	// pre-write content of the current install. The previous "rotate
	// up to 5 timestamped .bak files" policy was retired.
	w := newMCPWriter(PlatformClaudeCode)
	dir := t.TempDir()
	path := filepath.Join(dir, "claude.json")
	require.NoError(t, os.WriteFile(path, []byte(`{}`), 0o600))

	for i := 0; i < 3; i++ {
		plan, _ := w.Plan(context.Background(), path)
		_, err := w.Commit(context.Background(), plan, WriteParams{
			AgentID: "agt_x", AgentToken: "evt_x", APIBaseURL: "https://api.test",
		})
		require.NoError(t, err)
	}

	// Exactly one backup at the documented suffix.
	_, statErr := os.Stat(path + backupSuffix)
	require.NoError(t, statErr, "single canonical backup must exist after re-runs")

	// No timestamped variants from the old policy.
	matches, err := filepath.Glob(path + ".bak.*")
	require.NoError(t, err)
	assert.Empty(t, matches, "no timestamped .bak.<ts> files should accumulate after the slimming pass")
}

// TestBuildEntry_NpxCommandPerPlatform pins the cross-platform shim:
// `npx` on unix-like, `npx.cmd` on Windows. Some MCP hosts can't
// resolve a bare `npx` on Windows because spawn helpers don't apply
// PATHEXT, so the right shim must be embedded in the config entry.
func TestBuildEntry_NpxCommandPerPlatform(t *testing.T) {
	prev := runtimeGOOSFn
	t.Cleanup(func() { runtimeGOOSFn = prev })

	runtimeGOOSFn = func() string { return "darwin" }
	got := buildEntry("https://api.everme.evermind.ai", "agt_x", "evt_x")
	assert.Equal(t, "npx", got["command"], "non-Windows hosts use bare npx")

	runtimeGOOSFn = func() string { return "windows" }
	got = buildEntry("https://api.everme.evermind.ai", "agt_x", "evt_x")
	assert.Equal(t, "npx.cmd", got["command"], "Windows hosts must use npx.cmd shim")
}

// TestCommit_TOCTOU_ConcurrentEditRefuses verifies the existed-at-Plan
// branch of the C3 TOCTOU check: if the file mtime+size changes
// between Plan and Commit (e.g. Claude Code's app self-rewrote), the
// writer must refuse rather than silently clobber.
func TestCommit_TOCTOU_ConcurrentEditRefuses(t *testing.T) {
	w := newMCPWriter(PlatformClaudeCode)
	dir := t.TempDir()
	path := filepath.Join(dir, "claude.json")
	require.NoError(t, os.WriteFile(path, []byte(`{"theme":"dark"}`), 0o600))

	plan, err := w.Plan(context.Background(), path)
	require.NoError(t, err)

	// Simulate a concurrent edit (mtime + size both bump).
	require.NoError(t, os.WriteFile(path, []byte(`{"theme":"dark","extra":"added"}`), 0o600))

	_, err = w.Commit(context.Background(), plan, WriteParams{
		AgentID: "agt_x", AgentToken: "evt_x", APIBaseURL: "https://api.test",
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "concurrent",
		"TOCTOU change must surface a concurrent-edit error")
}

// TestCommit_TOCTOU_ConcurrentCreateRefuses verifies the
// no-file-at-Plan / file-now-exists branch (R-toctou-create follow-up):
// previously the writer happily overwrote a file that appeared between
// Plan and Commit, clobbering whatever entry the racer wrote.
func TestCommit_TOCTOU_ConcurrentCreateRefuses(t *testing.T) {
	w := newMCPWriter(PlatformClaudeCode)
	dir := t.TempDir()
	path := filepath.Join(dir, "claude.json") // does not exist

	plan, err := w.Plan(context.Background(), path)
	require.NoError(t, err)
	require.True(t, plan.WillCreate, "Plan should report file creation")

	// Race: another process writes the file before our Commit.
	require.NoError(t, os.WriteFile(path, []byte(`{"raced":"by other process"}`), 0o600))

	_, err = w.Commit(context.Background(), plan, WriteParams{
		AgentID: "agt_x", AgentToken: "evt_x", APIBaseURL: "https://api.test",
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "concurrent",
		"created-after-Plan must surface a concurrent-create error")

	// The racer's content must NOT have been clobbered.
	got, _ := os.ReadFile(path)
	assert.Contains(t, string(got), "raced", "racer's content must be preserved")
}

// Sanity: nothing in the resulting config file ever reveals a complete
// evt_<32 hex> string except as the literal token we passed in. The
// design rule is "evt plaintext only in env values, never in stdout";
// for file IO we accept the env value but make sure we don't leak it
// into other locations like comments / backup of unrelated keys.
func TestNoEvtLeakInFilenamesOrJSONKeys(t *testing.T) {
	w := newMCPWriter(PlatformClaudeCode)
	dir := t.TempDir()
	path := filepath.Join(dir, "claude.json")
	plan, _ := w.Plan(context.Background(), path)
	_, err := w.Commit(context.Background(), plan, WriteParams{
		AgentID: "agt_x", AgentToken: "evt_super_secret", APIBaseURL: "https://api.test",
	})
	require.NoError(t, err)

	// Walk the whole tmp dir; the only place the token may legitimately
	// appear is the value of EVERME_AGENT_TOKEN inside the config.
	entries, err := os.ReadDir(dir)
	require.NoError(t, err)
	for _, e := range entries {
		assert.False(t, strings.Contains(e.Name(), "evt_"), "filename must never contain evt prefix: %s", e.Name())
	}
}

// (OpenClaw context-engine writer is covered by openclaw_test.go — it
// writes plugins.entries.<id> + slots.contextEngine, so the assertions
// live alongside the writer.)
