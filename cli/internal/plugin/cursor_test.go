package plugin

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestCursorDetector_NoConfig_NotInstalled covers the "Cursor not on
// this machine" path: no $HOME/.cursor dir, no cursor CLI, no config
// file. Detector must still return a usable Detection with ConfigPath
// populated so install can offer "--force" guidance.
func TestCursorDetector_NoConfig_NotInstalled(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("EVERCLI_CURSOR_CONFIG_DIR", dir)
	// Point HOME at a known-empty dir so the ~/.cursor probe also misses.
	t.Setenv("HOME", t.TempDir())

	d, err := cursorDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.Equal(t, PlatformCursor, d.Platform)
	assert.Equal(t, filepath.Join(dir, "mcp.json"), d.ConfigPath)
	assert.False(t, d.ConfigExists)
	assert.False(t, d.HasEverMeEntry)
}

// TestCursorDetector_ConfigWithEverMe_ReportsEntry proves HasEverMeEntry
// reads the canonical `mcpServers.everme-memory` JSON path — same shape
// the mcpWriter produces, so detection and write paths agree.
func TestCursorDetector_ConfigWithEverMe_ReportsEntry(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("EVERCLI_CURSOR_CONFIG_DIR", dir)
	t.Setenv("HOME", t.TempDir())

	path := filepath.Join(dir, "mcp.json")
	require.NoError(t, os.WriteFile(path, []byte(`{
      "mcpServers": {
        "everme-memory": {"command": "npx", "args": ["-y", "@everme/memory-mcp"]},
        "other": {"command": "noop"}
      }
    }`), 0o600))

	d, err := cursorDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.True(t, d.ConfigExists)
	assert.True(t, d.HasEverMeEntry, "must recognise existing everme-memory entry")
}

// TestCursorDetector_InstalledFromHomeDir confirms presence of
// ~/.cursor (the GUI's data dir) is enough to flag Cursor as installed
// even when the CLI isn't on PATH. Cursor's CLI is opt-in on macOS, so
// the dir-based heuristic is the load-bearing signal.
func TestCursorDetector_InstalledFromHomeDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("EVERCLI_CURSOR_CONFIG_DIR", t.TempDir())
	require.NoError(t, os.MkdirAll(filepath.Join(home, ".cursor"), 0o700))

	d, err := cursorDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.True(t, d.Installed)
}

// TestCursorWriter_DoesNotImplementLifecycleInterfaces guards the
// negative case of the shared *mcpWriter concrete type. Service.installOne
// uses runtime `wr.(Preparer)` / `wr.(Verifier)` type-assertion to
// decide whether to call those hooks. If someone later adds Prepare or
// Verify to *mcpWriter (e.g. to wire a Cursor-specific marketplace
// step), they would silently activate for Cursor, Claude Desktop, AND
// Claude Code at once. This test fails loudly the moment that happens
// so the author can re-think the layering before merging.
func TestCursorWriter_DoesNotImplementLifecycleInterfaces(t *testing.T) {
	w := newCursorWriter()
	_, isPreparer := any(w).(Preparer)
	assert.False(t, isPreparer, "cursor writer must NOT implement Preparer — shared *mcpWriter type would activate Prepare for claude-code and claude-desktop too")
	_, isVerifier := any(w).(Verifier)
	assert.False(t, isVerifier, "cursor writer must NOT implement Verifier — see comment in TestCursorWriter_DoesNotImplementLifecycleInterfaces")
}

// TestCursorWriter_UsesSharedMcpWriter pins the contract that
// newCursorWriter returns a writer producing the canonical
// `mcpServers.everme-memory` shape, so a single change to buildEntry()
// propagates to Cursor too — no duplicate JSON shape to maintain.
func TestCursorWriter_UsesSharedMcpWriter(t *testing.T) {
	w := newCursorWriter()
	dir := t.TempDir()
	path := filepath.Join(dir, "mcp.json")

	plan, err := w.Plan(context.Background(), path)
	require.NoError(t, err)

	_, err = w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_cursor",
		AgentToken: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	})
	require.NoError(t, err)

	got := readJSON(t, path)
	servers, ok := got["mcpServers"].(map[string]interface{})
	require.True(t, ok, "top-level mcpServers required")
	entry, ok := servers["everme-memory"].(map[string]interface{})
	require.True(t, ok, "mcpServers.everme-memory required")
	env, _ := entry["env"].(map[string]interface{})
	assert.Equal(t, "agt_cursor", env["EVERME_AGENT_ID"])
}
