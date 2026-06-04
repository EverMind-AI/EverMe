package plugin

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Not installed: config dir does not exist, no opencode CLI. Detect must
// still return a usable Detection with ConfigPath set. NOTE: opencode's
// "installed" signal is os.Stat(filepath.Dir(configPath)), so the dir
// must NOT exist here or Installed would be wrongly true.
func TestOpenCodeDetector_NoConfig_NotInstalled(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "does-not-exist")
	t.Setenv("EVERCLI_OPENCODE_CONFIG_DIR", dir)
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", "")

	d, err := opencodeDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.Equal(t, PlatformOpenCode, d.Platform)
	assert.Equal(t, filepath.Join(dir, "opencode.json"), d.ConfigPath)
	assert.False(t, d.ConfigExists)
	assert.False(t, d.HasEverMeEntry)
	assert.False(t, d.Installed, "non-existent config dir + no opencode CLI => not installed")
}

// Config dir present => installed.
func TestOpenCodeDetector_InstalledFromConfigDir(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("EVERCLI_OPENCODE_CONFIG_DIR", dir) // dir itself exists
	t.Setenv("HOME", t.TempDir())

	d, err := opencodeDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.True(t, d.Installed)
}

// HasEverMeEntry is token-gated: true when mcp.everme-memory has a token
// under environment; a scaffold without a token reads as not-configured.
func TestOpenCodeDetector_HasEverMeEntry_TokenGated(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("EVERCLI_OPENCODE_CONFIG_DIR", dir)
	t.Setenv("HOME", t.TempDir())
	path := filepath.Join(dir, "opencode.json")

	require.NoError(t, os.WriteFile(path, []byte(`{
      "mcp": {
        "everme-memory": {"type":"local","command":["npx","-y","@everme/memory-mcp"],
          "environment":{"EVERME_AGENT_TOKEN":"evt_x"},"enabled":true}
      }
    }`), 0o600))
	d, err := opencodeDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.True(t, d.ConfigExists)
	assert.True(t, d.HasEverMeEntry)

	require.NoError(t, os.WriteFile(path, []byte(`{
      "mcp": {"everme-memory": {"type":"local","command":["npx"],"environment":{}}}
    }`), 0o600))
	d, err = opencodeDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.False(t, d.HasEverMeEntry)
}

// Plan->Commit writes opencode shape: mcp.everme-memory with
// type/command(array)/environment/enabled; sibling entries round-trip.
func TestOpenCodeWriter_WritesOpenCodeShape(t *testing.T) {
	w := newOpenCodeWriter()
	dir := t.TempDir()
	path := filepath.Join(dir, "opencode.json")
	require.NoError(t, os.WriteFile(path, []byte(`{
      "$schema":"https://opencode.ai/config.json",
      "mcp": {"keep-me": {"type":"local","command":["noop"]}}
    }`), 0o600))

	plan, err := w.Plan(context.Background(), path)
	require.NoError(t, err)

	_, err = w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_oc",
		AgentToken: "evt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	})
	require.NoError(t, err)

	got := readJSON(t, path)
	mcp, ok := got["mcp"].(map[string]interface{})
	require.True(t, ok, "top-level mcp required")
	assert.Contains(t, mcp, "keep-me", "sibling entries must round-trip")
	entry, ok := mcp["everme-memory"].(map[string]interface{})
	require.True(t, ok, "mcp.everme-memory required")
	assert.Equal(t, "local", entry["type"])
	assert.Equal(t, true, entry["enabled"])
	cmd, ok := entry["command"].([]interface{})
	require.True(t, ok, "command must be an array")
	assert.Equal(t, []interface{}{"npx", "-y", "@everme/memory-mcp"}, cmd)
	env, ok := entry["environment"].(map[string]interface{})
	require.True(t, ok, "environment (not env) required")
	assert.Equal(t, "agt_oc", env["EVERME_AGENT_ID"])
	assert.Equal(t, "evt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", env["EVERME_AGENT_TOKEN"])
}

// Fresh-config path: parent dir created, file lands 0600.
func TestOpenCodeWriter_CreatesFreshConfig(t *testing.T) {
	w := newOpenCodeWriter()
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "opencode.json")

	plan, err := w.Plan(context.Background(), path)
	require.NoError(t, err)
	assert.True(t, plan.WillCreate)

	res, err := w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_oc",
		AgentToken: "evt_cccccccccccccccccccccccccccccccc",
	})
	require.NoError(t, err)
	assert.True(t, res.WroteNewEntry)

	info, statErr := os.Stat(path)
	require.NoError(t, statErr)
	assert.Equal(t, os.FileMode(0o600), info.Mode().Perm())
}

// TOCTOU: file changed between Plan and Commit => Commit refuses.
func TestOpenCodeWriter_RefusesConcurrentChange(t *testing.T) {
	w := newOpenCodeWriter()
	dir := t.TempDir()
	path := filepath.Join(dir, "opencode.json")
	require.NoError(t, os.WriteFile(path, []byte(`{"mcp":{}}`), 0o600))

	plan, err := w.Plan(context.Background(), path)
	require.NoError(t, err)

	require.NoError(t, os.WriteFile(path, []byte(`{"mcp":{"x":{"type":"local"}}}`), 0o600))

	_, err = w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_oc",
		AgentToken: "evt_dddddddddddddddddddddddddddddddd",
	})
	require.Error(t, err, "Commit must refuse after a concurrent edit")
}

// opencodeWriter must not implement Preparer/Verifier (v1 install-only).
func TestOpenCodeWriter_DoesNotImplementLifecycleInterfaces(t *testing.T) {
	w := newOpenCodeWriter()
	_, isPreparer := any(w).(Preparer)
	assert.False(t, isPreparer)
	_, isVerifier := any(w).(Verifier)
	assert.False(t, isVerifier)
}
