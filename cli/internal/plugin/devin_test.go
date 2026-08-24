package plugin

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDevinDetector_ConfigWithEverMeReportsEntry(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("EVERCLI_DEVIN_CONFIG_DIR", dir)
	t.Setenv("HOME", t.TempDir())
	path := filepath.Join(dir, "mcp_config.json")
	require.NoError(t, os.WriteFile(path, []byte(`{"mcpServers":{"everme-memory":{"command":"npx"}}}`), 0o600))

	detection, err := devinDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.Equal(t, PlatformDevin, detection.Platform)
	assert.Equal(t, "Devin", detection.DisplayName)
	assert.True(t, detection.ConfigExists)
	assert.True(t, detection.HasEverMeEntry)
}

// Devin moved its user config out of the Windsurf tree: running it with
// an MCP config at ~/.codeium/windsurf pops a dialog offering to copy it
// to ~/.config/devin. Installing to the old path means every user gets
// that prompt, and accepting it leaves the agent token in a second file
// that `plugin uninstall` does not know about.
func TestDevinConfigPath_UsesCurrentUserConfigDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("EVERCLI_DEVIN_CONFIG_DIR", "")

	path, err := devinConfigPath()
	require.NoError(t, err)
	assert.Equal(t, filepath.Join(home, ".config", "devin", "mcp_config.json"), path)
}

// Installs made before the move live in the Windsurf tree. Detection has
// to report where the entry actually is, otherwise uninstall cleans an
// empty file and leaves the real token behind.
func TestDevinDetect_ReportsLegacyPathWhenTheEntryLivesThere(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("EVERCLI_DEVIN_CONFIG_DIR", "")
	legacy := filepath.Join(home, ".codeium", "windsurf", "mcp_config.json")
	require.NoError(t, os.MkdirAll(filepath.Dir(legacy), 0o700))
	require.NoError(t, os.WriteFile(legacy, []byte(`{"mcpServers":{"everme-memory":{"command":"npx"}}}`), 0o600))

	detection, err := devinDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.Equal(t, legacy, detection.ConfigPath)
	assert.True(t, detection.ConfigExists)
	assert.True(t, detection.HasEverMeEntry)
}

func TestDevinDetect_PrefersTheCurrentLocationWhenBothHaveAnEntry(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("EVERCLI_DEVIN_CONFIG_DIR", "")
	entry := []byte(`{"mcpServers":{"everme-memory":{"command":"npx"}}}`)
	for _, p := range []string{
		filepath.Join(home, ".codeium", "windsurf", "mcp_config.json"),
		filepath.Join(home, ".config", "devin", "mcp_config.json"),
	} {
		require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o700))
		require.NoError(t, os.WriteFile(p, entry, 0o600))
	}

	detection, err := devinDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.Equal(t, filepath.Join(home, ".config", "devin", "mcp_config.json"), detection.ConfigPath)
}

// Devin's own copy prompt duplicates the token across both locations, so
// removing one is not enough: uninstall must sweep the legacy path too.
func TestDevinRemove_SweepsTheLegacyLocationToo(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("EVERCLI_DEVIN_CONFIG_DIR", "")
	entry := []byte(`{"mcpServers":{"everme-memory":{"command":"npx","env":{"EVERME_AGENT_TOKEN":"evt_x"}},"other":{"command":"keep"}}}`)
	current := filepath.Join(home, ".config", "devin", "mcp_config.json")
	legacy := filepath.Join(home, ".codeium", "windsurf", "mcp_config.json")
	for _, p := range []string{current, legacy} {
		require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o700))
		require.NoError(t, os.WriteFile(p, entry, 0o600))
	}

	res, err := newDevinWriter().(Remover).Remove(context.Background(), current)
	require.NoError(t, err)
	assert.True(t, res.Removed)

	for _, p := range []string{current, legacy} {
		cfg, exists, err := readConfig(p)
		require.NoError(t, err)
		require.True(t, exists, p)
		servers := cfg["mcpServers"].(map[string]interface{})
		assert.NotContains(t, servers, mcpEntryName, "everme entry must be gone from %s", p)
		assert.Contains(t, servers, "other", "unrelated servers must survive in %s", p)
	}
}

func TestDevinWriter_WritesMCPHookAndProtectedEnv(t *testing.T) {
	dir := t.TempDir()
	mcpPath := filepath.Join(dir, "mcp_config.json")
	hooksPath := filepath.Join(dir, "hooks.json")
	require.NoError(t, os.WriteFile(mcpPath, []byte(`{
      "mcpServers":{"other":{"command":"other-mcp"}}
    }`), 0o644))
	require.NoError(t, os.WriteFile(hooksPath, []byte(`{
      "hooks": {
        "post_cascade_response_with_transcript": [
          {"command":"other-transcript-hook"},
          {"command":"npx -y @everme/windsurf@latest hook post_cascade_response_with_transcript"},
          {"command":"npx -y @everme/devin@old hook post_cascade_response_with_transcript"}
        ],
        "pre_user_prompt":[{"command":"policy-check"}]
      }
    }`), 0o644))

	writer := newDevinWriter()
	plan, err := writer.Plan(context.Background(), mcpPath)
	require.NoError(t, err)
	_, err = writer.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_devin",
		AgentToken: "test-agent-token",
	})
	require.NoError(t, err)

	mcp := readJSON(t, mcpPath)
	assert.Equal(t, "other-mcp", mcp["mcpServers"].(map[string]interface{})["other"].(map[string]interface{})["command"])
	hooks := readJSON(t, hooksPath)
	assert.Contains(t, hookCommands(t, hooks, "post_cascade_response_with_transcript"), "other-transcript-hook")
	assert.Contains(t, hookCommands(t, hooks, "pre_user_prompt"), "policy-check")
	assert.NotContains(t, hookCommands(t, hooks, "post_cascade_response_with_transcript"), "npx -y @everme/windsurf@latest hook post_cascade_response_with_transcript")
	assert.Equal(t, 1, countOwnedHookCommands(t, hooks, "post_cascade_response_with_transcript", "@everme/devin@latest"))
	info, err := os.Stat(filepath.Join(dir, "everme.env"))
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), info.Mode().Perm())
}

// The legacy sweep must be scoped to a real uninstall of this host. An
// earlier version keyed it off $HOME alone, so removing an unrelated
// config path reached into ~/.codeium/windsurf and cleaned the developer's
// actual install - a test with a temp config dir but no HOME override was
// enough to do it.
func TestDevinRemove_DoesNotReachOutsideTheRequestedConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("EVERCLI_DEVIN_CONFIG_DIR", "")
	entry := []byte(`{"mcpServers":{"everme-memory":{"command":"npx"}}}`)
	legacy := filepath.Join(home, ".codeium", "windsurf", "mcp_config.json")
	require.NoError(t, os.MkdirAll(filepath.Dir(legacy), 0o700))
	require.NoError(t, os.WriteFile(legacy, entry, 0o600))

	// An unrelated config path, the shape a writer unit test uses.
	unrelated := filepath.Join(t.TempDir(), "mcp.json")
	require.NoError(t, os.WriteFile(unrelated, entry, 0o600))

	_, err := newDevinWriter().(Remover).Remove(context.Background(), unrelated)
	require.NoError(t, err)

	cfg, exists, err := readConfig(legacy)
	require.NoError(t, err)
	require.True(t, exists, "the legacy config must still be there")
	assert.Contains(t, cfg["mcpServers"], mcpEntryName,
		"removing an unrelated config must not touch the host's own location")
	_, statErr := os.Stat(legacy + backupSuffix)
	assert.True(t, os.IsNotExist(statErr), "and must not leave a backup behind either")
}

// Devin reads MCP config and hooks from DIFFERENT trees, so they cannot
// both be derived from one directory. Its own dialog demands mcp_config
// live at ~/.config/devin, but hook discovery loads the Windsurf tree
// (provider "windsurf"): with hooks.json written next to the new
// mcp_config, a real session logged `loaded=7 (global=7 cascade=0)` -
// exactly the seven probes still sitting in ~/.codeium/windsurf, and
// nothing from ~/.config/devin.
func TestDevinHooksPath_StaysInTheWindsurfTree(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("EVERCLI_DEVIN_CONFIG_DIR", "")

	configPath, err := devinConfigPath()
	require.NoError(t, err)
	require.Equal(t, filepath.Join(home, ".config", "devin", "mcp_config.json"), configPath)

	assert.Equal(t,
		filepath.Join(home, ".codeium", "windsurf", "hooks.json"),
		devinHooksPath(configPath),
		"hooks must go where Devin's windsurf provider looks, not beside mcp_config")
}

// Devin never emitted post_cascade_response_with_transcript in a real
// session, so registering only that event meant the hook never ran. It
// does emit pre_user_prompt, post_run_command and post_cascade_response -
// the question, the tool call, and the answer.
func TestDevinWriter_RegistersTheEventsDevinEmits(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := t.TempDir()
	t.Setenv("EVERCLI_DEVIN_CONFIG_DIR", dir)
	mcpPath := filepath.Join(dir, "mcp_config.json")

	w := newDevinWriter()
	plan, err := w.Plan(context.Background(), mcpPath)
	require.NoError(t, err)
	_, err = w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_devin",
		AgentToken: testEvtToken,
	})
	require.NoError(t, err)

	hooks := readJSON(t, filepath.Join(dir, "hooks.json"))
	for _, event := range []string{"pre_user_prompt", "post_run_command", "post_read_code", "post_cascade_response"} {
		assert.Equal(t, 1, countOwnedHookCommands(t, hooks, event, "@everme/devin@latest"),
			"exactly one EverMe hook on %s", event)
	}
}
