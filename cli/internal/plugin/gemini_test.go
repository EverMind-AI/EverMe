package plugin

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Not installed: no ~/.gemini dir, no gemini CLI, no config file. Detect
// must still return a usable Detection with ConfigPath set.
func TestGeminiDetector_NoConfig_NotInstalled(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("EVERCLI_GEMINI_CONFIG_DIR", dir)
	t.Setenv("HOME", t.TempDir())

	d, err := geminiDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.Equal(t, PlatformGemini, d.Platform)
	assert.Equal(t, filepath.Join(dir, "settings.json"), d.ConfigPath)
	assert.False(t, d.ConfigExists)
	assert.False(t, d.HasEverMeEntry)
}

// HasEverMeEntry is true when mcpServers.everme-memory already exists.
func TestGeminiDetector_ConfigWithEverMe_ReportsEntry(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("EVERCLI_GEMINI_CONFIG_DIR", dir)
	t.Setenv("HOME", t.TempDir())

	path := filepath.Join(dir, "settings.json")
	require.NoError(t, os.WriteFile(path, []byte(`{
      "mcpServers": {
        "everme-memory": {"command": "npx", "args": ["-y", "@everme/memory-mcp"]},
        "other": {"command": "noop"}
      }
    }`), 0o600))

	d, err := geminiDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.True(t, d.ConfigExists)
	assert.True(t, d.HasEverMeEntry)
}

// Presence of ~/.gemini is enough to flag installed, even when the CLI
// isn't on PATH.
func TestGeminiDetector_InstalledFromHomeDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("EVERCLI_GEMINI_CONFIG_DIR", t.TempDir())
	require.NoError(t, os.MkdirAll(filepath.Join(home, ".gemini"), 0o700))

	d, err := geminiDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.True(t, d.Installed)
}

// Writer reuses the shared mcpWriter: Plan→Commit writes
// mcpServers.everme-memory with the token in env.
func TestGeminiWriter_WritesMcpServersEntry(t *testing.T) {
	w := newGeminiWriter()
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")

	plan, err := w.Plan(context.Background(), path)
	require.NoError(t, err)

	_, err = w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_gemini",
		AgentToken: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	})
	require.NoError(t, err)

	got := readJSON(t, path)
	servers, ok := got["mcpServers"].(map[string]interface{})
	require.True(t, ok, "top-level mcpServers required")
	entry, ok := servers["everme-memory"].(map[string]interface{})
	require.True(t, ok, "mcpServers.everme-memory required")
	env, _ := entry["env"].(map[string]interface{})
	assert.Equal(t, "agt_gemini", env["EVERME_AGENT_ID"])
}

// The shared mcpWriter must NOT implement Preparer/Verifier — that would
// also activate them for cursor/claude-desktop/claude-code.
func TestGeminiWriter_DoesNotImplementLifecycleInterfaces(t *testing.T) {
	w := newGeminiWriter()
	_, isPreparer := any(w).(Preparer)
	assert.False(t, isPreparer)
	_, isVerifier := any(w).(Verifier)
	assert.False(t, isVerifier)
}
