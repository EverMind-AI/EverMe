package plugin

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWorkBuddyConfigPathIsCanonical(t *testing.T) {
	tests := []struct {
		name   string
		create []string
	}{
		{name: "defaults to desktop mcp on a fresh install"},
		{name: "ignores cli dot mcp", create: []string{".mcp.json"}},
		{name: "ignores app-shipped connector marketplace", create: []string{"connectors/default/mcp.json"}},
		{name: "ignores every app-owned file at once", create: []string{".mcp.json", "connectors/default/mcp.json"}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("EVERCLI_WORKBUDDY_CONFIG_DIR", dir)
			for _, relative := range test.create {
				path := filepath.Join(dir, filepath.FromSlash(relative))
				require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o700))
				require.NoError(t, os.WriteFile(path, []byte(`{"mcpServers":{}}`), 0o600))
			}

			got, err := workBuddyConfigPath()
			require.NoError(t, err)
			assert.Equal(t, filepath.Join(dir, "mcp.json"), got)
		})
	}
}

func TestWorkBuddyDetectorUsesDirectoryOrAppAndFindsEverMe(t *testing.T) {
	t.Run("config directory", func(t *testing.T) {
		dir := t.TempDir()
		t.Setenv("EVERCLI_WORKBUDDY_CONFIG_DIR", dir)
		path := filepath.Join(dir, "mcp.json")
		require.NoError(t, os.WriteFile(path, []byte(`{"mcpServers":{"everme-memory":{}}}`), 0o600))

		detection, err := (workBuddyDetector{}).Detect(t.Context())
		require.NoError(t, err)
		assert.Equal(t, PlatformWorkBuddy, detection.Platform)
		assert.Equal(t, "WorkBuddy", detection.DisplayName)
		assert.True(t, detection.Installed)
		assert.True(t, detection.ConfigExists)
		assert.True(t, detection.HasEverMeEntry)
		assert.Equal(t, path, detection.ConfigPath)
	})

	t.Run("application", func(t *testing.T) {
		root := t.TempDir()
		configDir := filepath.Join(root, "missing-config")
		appPath := filepath.Join(root, "WorkBuddy.app")
		require.NoError(t, os.MkdirAll(appPath, 0o700))
		t.Setenv("EVERCLI_WORKBUDDY_CONFIG_DIR", configDir)
		t.Setenv("EVERCLI_WORKBUDDY_APP_PATH", appPath)

		detection, err := (workBuddyDetector{}).Detect(t.Context())
		require.NoError(t, err)
		assert.True(t, detection.Installed)
		assert.False(t, detection.ConfigExists)
		assert.Equal(t, filepath.Join(configDir, "mcp.json"), detection.ConfigPath)
	})
}

func TestWorkBuddyWriterPreservesConnectorProxy(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mcp.json")
	require.NoError(t, os.WriteFile(path, []byte(`{
  "mcpServers": {
    "connector-proxy": {"command":"node","args":["proxy.js"]}
  }
}`), 0o600))

	writer := newWorkBuddyWriter()
	plan, err := writer.Plan(context.Background(), path)
	require.NoError(t, err)
	_, err = writer.Commit(context.Background(), plan, WriteParams{
		AgentID:    "agt_workbuddy",
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
	assert.Contains(t, config.MCPServers, "connector-proxy")
	assert.Contains(t, config.MCPServers, mcpEntryName)
}

// WorkBuddy refuses to start an untrusted MCP server, so the install
// result must carry the manual trust follow-up for the CLI to print.
func TestWorkBuddyWriterCommitSurfacesTrustNextStep(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mcp.json")
	writer := newWorkBuddyWriter()
	plan, err := writer.Plan(context.Background(), path)
	require.NoError(t, err)
	res, err := writer.Commit(context.Background(), plan, WriteParams{
		AgentID:    "agt_workbuddy",
		AgentToken: "test-token",
		APIBaseURL: "https://api.test",
	})
	require.NoError(t, err)
	require.Len(t, res.NextSteps, 1)
	assert.Contains(t, res.NextSteps[0], "trust the everme-memory server")
}

func TestWorkBuddyWriterCreatesSecureConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mcp.json")
	writer := newWorkBuddyWriter()
	plan, err := writer.Plan(context.Background(), path)
	require.NoError(t, err)
	_, err = writer.Commit(context.Background(), plan, WriteParams{
		AgentID:    "agt_workbuddy",
		AgentToken: "test-token",
		APIBaseURL: "https://api.test",
	})
	require.NoError(t, err)

	info, err := os.Stat(path)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), info.Mode().Perm())
}
