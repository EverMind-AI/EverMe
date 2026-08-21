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

func TestHookWriter_RejectsAuxiliaryFileChangesBeforeAnyMutation(t *testing.T) {
	dir := t.TempDir()
	mcpPath := filepath.Join(dir, "mcp.json")
	hooksPath := filepath.Join(dir, "hooks.json")
	originalMCP := []byte(`{"mcpServers":{"other":{"command":"other-mcp"}}}`)
	require.NoError(t, os.WriteFile(mcpPath, originalMCP, 0o600))
	require.NoError(t, os.WriteFile(hooksPath, []byte(`{"version":1,"hooks":{}}`), 0o600))

	w := newCursorWriter()
	plan, err := w.Plan(context.Background(), mcpPath)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(hooksPath, []byte(`{"version":1,"hooks":{"custom":[]}}`), 0o600))

	_, err = w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_cursor",
		AgentToken: "test-agent-token",
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "concurrent")
	got, readErr := os.ReadFile(mcpPath)
	require.NoError(t, readErr)
	assert.JSONEq(t, string(originalMCP), string(got))
	_, statErr := os.Stat(filepath.Join(dir, "everme.env"))
	assert.ErrorIs(t, statErr, os.ErrNotExist)
}

// TestNativeHookWriter_Remove_MapShapeHooks pins the HIGH bug: hooks
// written by mergeFlatHooks live in the map shape
// {"hooks": {event: [entries]}}, but the old removeHooks only handled a
// flat array — so cursor/devin uninstall silently left EverMe hooks
// behind. Remove must delete only EverMe-owned entries (matched on the
// entry's command field), preserve user siblings — including one whose
// unrelated field mentions "everme" — remove everme.env, and leave a
// hooks.json backup.
func TestNativeHookWriter_Remove_MapShapeHooks(t *testing.T) {
	cases := []struct {
		name      string
		newWriter func() Writer
		event     string
		evermeCmd string
	}{
		{"cursor", newCursorWriter, "sessionStart", "npx -y @everme/cursor@latest hook sessionStart"},
		{"devin", newDevinWriter, "post_cascade_response_with_transcript", "npx -y @everme/devin@latest hook post_cascade_response_with_transcript"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// No writer test may resolve a host path against the real home.
			t.Setenv("HOME", t.TempDir())
			dir := t.TempDir()
			mcpPath := filepath.Join(dir, "mcp.json")
			hooksPath := filepath.Join(dir, "hooks.json")
			envPath := filepath.Join(dir, "everme.env")

			require.NoError(t, os.WriteFile(mcpPath, []byte(
				`{"mcpServers":{"everme-memory":{"command":"npx"},"other":{"command":"other-mcp"}}}`), 0o600))
			hooksCfg := map[string]interface{}{
				"version": 1,
				"hooks": map[string]interface{}{
					tc.event: []interface{}{
						map[string]interface{}{"command": tc.evermeCmd},
						// User hook whose unrelated field mentions everme —
						// must survive (no marshal-the-entry substring match).
						map[string]interface{}{
							"command": "my-custom-hook.sh",
							"notes":   "runs alongside everme",
						},
						map[string]interface{}{"command": "other-tool hook"},
					},
				},
			}
			raw, err := json.Marshal(hooksCfg)
			require.NoError(t, err)
			require.NoError(t, os.WriteFile(hooksPath, raw, 0o600))
			require.NoError(t, os.WriteFile(envPath, []byte("# managed\nEVERME_AGENT_TOKEN=evt_x\n"), 0o600))

			rm, ok := tc.newWriter().(Remover)
			require.True(t, ok, "native hook writer must implement Remover")
			res, err := rm.Remove(context.Background(), mcpPath)
			require.NoError(t, err)
			assert.True(t, res.Removed)

			// mcp.json: everme-memory gone, sibling preserved.
			mcpCfg, exists, err := readConfig(mcpPath)
			require.NoError(t, err)
			require.True(t, exists)
			servers, ok := mcpCfg["mcpServers"].(map[string]interface{})
			require.True(t, ok)
			assert.NotContains(t, servers, "everme-memory")
			assert.Contains(t, servers, "other")

			// hooks.json: EverMe entry gone, both user siblings preserved.
			gotHooks, exists, err := readConfig(hooksPath)
			require.NoError(t, err)
			require.True(t, exists)
			commands := hookCommands(t, gotHooks, tc.event)
			assert.NotContains(t, commands, tc.evermeCmd)
			assert.Contains(t, commands, "my-custom-hook.sh",
				"user hook mentioning everme in an unrelated field must survive")
			assert.Contains(t, commands, "other-tool hook")

			// everme.env deleted; hooks.json backup left behind.
			_, statErr := os.Stat(envPath)
			assert.ErrorIs(t, statErr, os.ErrNotExist)
			_, bakErr := os.Stat(hooksPath + backupSuffix)
			assert.NoError(t, bakErr, "hooks.json must be backed up before the rewrite")
		})
	}
}

// TestNativeHookWriter_Remove_FlatArrayHooks keeps the legacy flat-array
// shape working: entries whose command contains everme are dropped,
// siblings survive verbatim.
func TestNativeHookWriter_Remove_FlatArrayHooks(t *testing.T) {
	dir := t.TempDir()
	mcpPath := filepath.Join(dir, "mcp.json")
	hooksPath := filepath.Join(dir, "hooks.json")
	require.NoError(t, os.WriteFile(mcpPath, []byte(`{"mcpServers":{"everme-memory":{}}}`), 0o600))
	require.NoError(t, os.WriteFile(hooksPath, []byte(
		`{"hooks":[{"command":"npx -y @everme/cursor@latest hook stop"},{"command":"user-hook"}]}`), 0o600))

	rm := newCursorWriter().(Remover)
	res, err := rm.Remove(context.Background(), mcpPath)
	require.NoError(t, err)
	assert.True(t, res.Removed)

	got, exists, err := readConfig(hooksPath)
	require.NoError(t, err)
	require.True(t, exists)
	entries, ok := got["hooks"].([]interface{})
	require.True(t, ok, "flat array shape must be preserved")
	require.Len(t, entries, 1)
	row, ok := entries[0].(map[string]interface{})
	require.True(t, ok)
	assert.Equal(t, "user-hook", row["command"])
}

func TestDropEverMeHookEntries_MatchesManagedPackagesOnly(t *testing.T) {
	entries := []interface{}{
		map[string]interface{}{"command": "npx -y @everme/cursor@latest hook stop"},
		map[string]interface{}{"command": "npx -y @everme/devin@0.3.4 hook post_cascade_response_with_transcript"},
		map[string]interface{}{"command": "npx -y @everme/windsurf@latest hook post_cascade_response_with_transcript"},
		map[string]interface{}{"command": "/Users/me/bin/backup-everme-notes.sh"},
		map[string]interface{}{"command": "npx -y @everme/cursor-tools@latest hook stop"},
		map[string]interface{}{"command": "user-hook"},
	}

	kept, dropped := dropEverMeHookEntries(entries)

	require.True(t, dropped)
	require.Len(t, kept, 3)
	commands := make([]string, 0, len(kept))
	for _, entry := range kept {
		row, ok := entry.(map[string]interface{})
		require.True(t, ok)
		commands = append(commands, row["command"].(string))
	}
	assert.Equal(t, []string{
		"/Users/me/bin/backup-everme-notes.sh",
		"npx -y @everme/cursor-tools@latest hook stop",
		"user-hook",
	}, commands)
}

func hookCommands(t *testing.T, cfg map[string]interface{}, event string) []string {
	t.Helper()
	hooks, ok := cfg["hooks"].(map[string]interface{})
	require.True(t, ok, "hooks object missing")
	eventValue, ok := hooks[event]
	require.True(t, ok, "event %s missing", event)
	commands := []string{}
	collectCommands(eventValue, &commands)
	return commands
}

func countOwnedHookCommands(t *testing.T, cfg map[string]interface{}, event, marker string) int {
	t.Helper()
	count := 0
	for _, command := range hookCommands(t, cfg, event) {
		if strings.Contains(command, marker) {
			count++
		}
	}
	return count
}

func collectCommands(value interface{}, commands *[]string) {
	switch typed := value.(type) {
	case []interface{}:
		for _, item := range typed {
			collectCommands(item, commands)
		}
	case map[string]interface{}:
		if command, ok := typed["command"].(string); ok {
			*commands = append(*commands, command)
		}
		for key, item := range typed {
			if key != "command" {
				collectCommands(item, commands)
			}
		}
	case json.RawMessage:
		var decoded interface{}
		if json.Unmarshal(typed, &decoded) == nil {
			collectCommands(decoded, commands)
		}
	}
}
