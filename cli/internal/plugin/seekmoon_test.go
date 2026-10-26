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
)

func TestSeekMoonConfigPathIsCanonical(t *testing.T) {
	t.Run("override pins the runtime directory", func(t *testing.T) {
		dir := t.TempDir()
		t.Setenv("EVERCLI_SEEKMOON_CONFIG_DIR", dir)

		got, err := seekMoonConfigPath()
		require.NoError(t, err)
		assert.Equal(t, filepath.Join(dir, "host-mcp.json"), got)
	})

	t.Run("defaults into the app runtime directory", func(t *testing.T) {
		t.Setenv("EVERCLI_SEEKMOON_CONFIG_DIR", "")

		got, err := seekMoonConfigPath()
		require.NoError(t, err)
		dir, err := seekMoonConfigDir()
		require.NoError(t, err)
		assert.Equal(t, filepath.Join(dir, "host-mcp.json"), got)
		// The app's own directory name is part of the contract: SeekMoon
		// reads host-mcp.json from its runtime directory only.
		assert.True(t, strings.HasSuffix(dir, "SeekMoon"), "runtime dir = %q", dir)
	})
}

func TestSeekMoonDetectorUsesDirectoryOrAppAndFindsEverMe(t *testing.T) {
	t.Run("runtime directory with an existing entry", func(t *testing.T) {
		dir := t.TempDir()
		t.Setenv("EVERCLI_SEEKMOON_CONFIG_DIR", dir)
		path := filepath.Join(dir, "host-mcp.json")
		require.NoError(t, os.WriteFile(path, []byte(`{"mcpServers":{"seekmoon":{"url":"http://127.0.0.1:1/mcp"},"everme-memory":{}}}`), 0o600))

		detection, err := (seekMoonDetector{}).Detect(t.Context())
		require.NoError(t, err)
		assert.Equal(t, PlatformSeekMoon, detection.Platform)
		assert.Equal(t, "SeekMoon", detection.DisplayName)
		assert.True(t, detection.Installed)
		assert.True(t, detection.ConfigExists)
		assert.True(t, detection.HasEverMeEntry)
		assert.Equal(t, path, detection.ConfigPath)
	})

	t.Run("application bundle only", func(t *testing.T) {
		root := t.TempDir()
		configDir := filepath.Join(root, "missing-config")
		appPath := filepath.Join(root, "SeekMoon.app")
		require.NoError(t, os.MkdirAll(appPath, 0o700))
		t.Setenv("EVERCLI_SEEKMOON_CONFIG_DIR", configDir)
		t.Setenv("EVERCLI_SEEKMOON_APP_PATH", appPath)

		detection, err := (seekMoonDetector{}).Detect(t.Context())
		require.NoError(t, err)
		assert.True(t, detection.Installed)
		assert.False(t, detection.ConfigExists)
		assert.False(t, detection.HasEverMeEntry)
		assert.Equal(t, filepath.Join(configDir, "host-mcp.json"), detection.ConfigPath)
	})
}

// The desktop publishes its own `seekmoon` tool server in the same file. An
// install must leave that entry — and any server the user added — untouched.
func TestSeekMoonWriterPreservesDesktopAndUserServers(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "host-mcp.json")
	require.NoError(t, os.WriteFile(path, []byte(`{
  "mcpServers": {
    "seekmoon": {"url": "${OPENSEEK_DESKTOP_TOOLS_URL}","headers":{"Authorization":"Bearer ${OPENSEEK_DESKTOP_TOOLS_TOKEN}"}},
    "user-server": {"command":"node","args":["server.js"]}
  }
}`), 0o600))

	writer := newSeekMoonWriter()
	plan, err := writer.Plan(context.Background(), path)
	require.NoError(t, err)
	_, err = writer.Commit(context.Background(), plan, WriteParams{
		AgentID:    "agt_seekmoon",
		AgentToken: "test-token",
		APIBaseURL: "https://api.test",
	})
	require.NoError(t, err)

	raw, err := os.ReadFile(path)
	require.NoError(t, err)
	var config struct {
		MCPServers map[string]json.RawMessage `json:"mcpServers"`
	}
	require.NoError(t, json.Unmarshal(raw, &config))
	assert.Contains(t, config.MCPServers, "seekmoon")
	assert.Contains(t, config.MCPServers, "user-server")
	assert.Contains(t, config.MCPServers, mcpEntryName)

	var entry struct {
		Command string            `json:"command"`
		Args    []string          `json:"args"`
		Env     map[string]string `json:"env"`
	}
	require.NoError(t, json.Unmarshal(config.MCPServers[mcpEntryName], &entry))
	assert.NotEmpty(t, entry.Command)
	assert.Contains(t, entry.Env, "EVERME_AGENT_TOKEN")
	assert.Equal(t, "test-token", entry.Env["EVERME_AGENT_TOKEN"])
}

// A conversation's engine connects its MCP servers once at startup, so the
// install result has to send the user to a new conversation instead of leaving
// them waiting for a server that will never appear in the current one.
func TestSeekMoonWriterCommitSurfacesNewConversationStep(t *testing.T) {
	path := filepath.Join(t.TempDir(), "host-mcp.json")
	writer := newSeekMoonWriter()
	plan, err := writer.Plan(context.Background(), path)
	require.NoError(t, err)
	res, err := writer.Commit(context.Background(), plan, WriteParams{
		AgentID:    "agt_seekmoon",
		AgentToken: "test-token",
		APIBaseURL: "https://api.test",
	})
	require.NoError(t, err)
	require.Len(t, res.NextSteps, 1)
	assert.Contains(t, res.NextSteps[0], "new conversation")
}

func TestSeekMoonWriterCreatesSecureConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "host-mcp.json")
	writer := newSeekMoonWriter()
	plan, err := writer.Plan(context.Background(), path)
	require.NoError(t, err)
	_, err = writer.Commit(context.Background(), plan, WriteParams{
		AgentID:    "agt_seekmoon",
		AgentToken: "test-token",
		APIBaseURL: "https://api.test",
	})
	require.NoError(t, err)

	info, err := os.Stat(path)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), info.Mode().Perm())
}

// Uninstall must drop only EverMe's entry: the desktop's own server is not ours
// to delete, and a missing entry is a successful no-op.
func TestSeekMoonWriterRemoveKeepsDesktopServer(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "host-mcp.json")
	writer := newSeekMoonWriter()
	plan, err := writer.Plan(context.Background(), path)
	require.NoError(t, err)
	_, err = writer.Commit(context.Background(), plan, WriteParams{
		AgentID:    "agt_seekmoon",
		AgentToken: "test-token",
		APIBaseURL: "https://api.test",
	})
	require.NoError(t, err)

	// Add the desktop's own entry the way SeekMoon does at launch.
	cfg, exists, err := readConfig(path)
	require.NoError(t, err)
	require.True(t, exists)
	servers, ok := cfg["mcpServers"].(map[string]interface{})
	require.True(t, ok)
	servers["seekmoon"] = map[string]interface{}{"url": "http://127.0.0.1:1/mcp"}
	require.NoError(t, writeConfigAtomic(path, cfg, configCarriesToken))

	remover := writer.(Remover)
	result, err := remover.Remove(context.Background(), path)
	require.NoError(t, err)
	assert.True(t, result.Removed)

	raw, err := os.ReadFile(path)
	require.NoError(t, err)
	var after struct {
		MCPServers map[string]json.RawMessage `json:"mcpServers"`
	}
	require.NoError(t, json.Unmarshal(raw, &after))
	assert.Contains(t, after.MCPServers, "seekmoon")
	assert.NotContains(t, after.MCPServers, mcpEntryName)

	// Idempotent: removing again changes nothing and reports not-removed.
	second, err := remover.Remove(context.Background(), path)
	require.NoError(t, err)
	assert.False(t, second.Removed)
}
