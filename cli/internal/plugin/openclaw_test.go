package plugin

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestOpenClawPluginIDConsistency guards the three plugin-side sources
// of truth against drift with the OpenClawPluginID constant. The fourth
// source (the constant itself) is treated as canonical and the others
// are compared to it — if any drifts, OpenClaw will start logging
// "Plugin manifest id X differs from npm package name Y" again.
//
// The path traversal is intentionally brittle: if the repo layout
// changes the test fails loudly here instead of silently skipping the
// check.
func TestOpenClawPluginIDConsistency(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	require.True(t, ok, "runtime.Caller failed — cannot locate test source")
	pluginDir := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "plugins", "openclaw")

	// 1. openclaw.plugin.json:id
	var manifest struct {
		ID string `json:"id"`
	}
	raw, err := os.ReadFile(filepath.Join(pluginDir, "openclaw.plugin.json"))
	require.NoError(t, err, "openclaw.plugin.json must be readable from cli tests")
	require.NoError(t, json.Unmarshal(raw, &manifest))
	assert.Equal(t, OpenClawPluginID, manifest.ID,
		"openclaw.plugin.json:id must equal OpenClawPluginID")

	// 2 + 3. package.json:name (npm package) and package.json:openclaw.id
	var pkg struct {
		Name     string `json:"name"`
		OpenClaw struct {
			ID string `json:"id"`
		} `json:"openclaw"`
	}
	raw, err = os.ReadFile(filepath.Join(pluginDir, "package.json"))
	require.NoError(t, err, "package.json must be readable from cli tests")
	require.NoError(t, json.Unmarshal(raw, &pkg))
	assert.Equal(t, OpenClawPluginID, pkg.Name,
		"package.json:name (npm package name) must equal OpenClawPluginID")
	assert.Equal(t, OpenClawPluginID, pkg.OpenClaw.ID,
		"package.json:openclaw.id must equal OpenClawPluginID")
}

// TestOpenClawWriter_Commit_FreshConfig proves a fresh openclaw.json
// gets the full context-engine shape: allow-list entry, slot binding,
// memory slot pinned to "none", and the per-agent config block — all
// under cfg.plugins.*.
func TestOpenClawWriter_Commit_FreshConfig(t *testing.T) {
	w := newOpenClawWriter()
	dir := t.TempDir()
	path := filepath.Join(dir, "openclaw.json")

	plan, err := w.Plan(context.Background(), path)
	require.NoError(t, err)
	assert.True(t, plan.WillCreate)
	assert.False(t, plan.WillReplace)

	_, err = w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "http://localhost:8080",
		AgentID:    "agt_test",
		AgentToken: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	})
	require.NoError(t, err)

	got := readJSON(t, path)

	// No MCP shape on OpenClaw any more — the context-engine plugin is
	// loaded in-process via plugins.entries, not spawned as an MCP
	// subprocess.
	_, hasFlat := got["mcpServers"]
	assert.False(t, hasFlat, "OpenClaw must not get top-level mcpServers")
	_, hasNestedMCP := got["mcp"]
	assert.False(t, hasNestedMCP, "OpenClaw must not get cfg.mcp")

	plugins, ok := got["plugins"].(map[string]interface{})
	require.True(t, ok, "expected cfg.plugins")

	// Allow-list contains our plugin id.
	allow, _ := plugins["allow"].([]interface{})
	assert.Contains(t, allow, OpenClawPluginID)

	// Slot binding: contextEngine pinned to us; memory disabled.
	slots, _ := plugins["slots"].(map[string]interface{})
	require.NotNil(t, slots, "expected plugins.slots")
	assert.Equal(t, OpenClawPluginID, slots["contextEngine"])
	assert.Equal(t, "none", slots["memory"])

	// Per-agent config under entries.<id>.config.
	entries, _ := plugins["entries"].(map[string]interface{})
	require.NotNil(t, entries, "expected plugins.entries")
	entry, _ := entries[OpenClawPluginID].(map[string]interface{})
	require.NotNil(t, entry, "expected plugins.entries.<id>")
	assert.Equal(t, true, entry["enabled"])
	cfg, _ := entry["config"].(map[string]interface{})
	require.NotNil(t, cfg, "expected entry.config")
	assert.Equal(t, "http://localhost:8080", cfg["apiBase"])
	assert.Equal(t, "agt_test", cfg["agentId"])
	assert.Equal(t, "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", cfg["agentToken"])
	// Numeric defaults survive a JSON round-trip as float64.
	assert.Equal(t, float64(5), cfg["topK"])
	assert.Equal(t, float64(5), cfg["flushEveryTurns"])
	assert.Equal(t, float64(65536), cfg["flushMaxBytes"])
}

// TestOpenClawWriter_Commit_PreservesSiblings: an existing openclaw.json
// with unrelated keys (agents, channels, other plugins) must round-trip
// untouched.
func TestOpenClawWriter_Commit_PreservesSiblings(t *testing.T) {
	w := newOpenClawWriter()
	dir := t.TempDir()
	path := filepath.Join(dir, "openclaw.json")

	original := map[string]interface{}{
		"agents": map[string]interface{}{
			"defaults": map[string]interface{}{
				"workspace": "/Users/x/.openclaw/workspace",
			},
		},
		"channels": map[string]interface{}{
			"feishu": map[string]interface{}{"enabled": true},
		},
		"plugins": map[string]interface{}{
			"allow": []interface{}{"feishu", "openrouter"},
			"entries": map[string]interface{}{
				"feishu":     map[string]interface{}{"enabled": true},
				"openrouter": map[string]interface{}{"enabled": true},
			},
		},
	}
	raw, _ := json.Marshal(original)
	require.NoError(t, os.WriteFile(path, raw, 0o600))

	plan, err := w.Plan(context.Background(), path)
	require.NoError(t, err)
	assert.False(t, plan.WillCreate)
	assert.False(t, plan.WillReplace, "fresh config has no <id> entry yet")

	_, err = w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "http://localhost:8080",
		AgentID:    "agt_test",
		AgentToken: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	})
	require.NoError(t, err)

	got := readJSON(t, path)
	plugins := got["plugins"].(map[string]interface{})

	// Sibling top-level keys intact.
	assert.NotNil(t, got["agents"])
	assert.NotNil(t, got["channels"])

	// Sibling plugin entries intact.
	entries := plugins["entries"].(map[string]interface{})
	assert.NotNil(t, entries["feishu"])
	assert.NotNil(t, entries["openrouter"])
	assert.NotNil(t, entries[OpenClawPluginID], "our entry added alongside siblings")

	// Allow-list appended (not replaced).
	allow := plugins["allow"].([]interface{})
	assert.Contains(t, allow, "feishu")
	assert.Contains(t, allow, "openrouter")
	assert.Contains(t, allow, OpenClawPluginID)
	assert.Len(t, allow, 3, "no duplicate entries on the allow-list")
}

// TestOpenClawWriter_Commit_ReplacesExistingEntry: re-installing must
// rewrite the entry config (new agentToken) without churning siblings.
// WillReplace=true is observable by callers via the WritePlan.
func TestOpenClawWriter_Commit_ReplacesExistingEntry(t *testing.T) {
	w := newOpenClawWriter()
	dir := t.TempDir()
	path := filepath.Join(dir, "openclaw.json")

	original := map[string]interface{}{
		"plugins": map[string]interface{}{
			"entries": map[string]interface{}{
				OpenClawPluginID: map[string]interface{}{
					"enabled": true,
					"config": map[string]interface{}{
						"agentToken": "evt_old",
					},
				},
			},
		},
	}
	raw, _ := json.Marshal(original)
	require.NoError(t, os.WriteFile(path, raw, 0o600))

	plan, err := w.Plan(context.Background(), path)
	require.NoError(t, err)
	assert.True(t, plan.WillReplace)

	_, err = w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "http://localhost:8080",
		AgentID:    "agt_new",
		AgentToken: "evt_new",
	})
	require.NoError(t, err)

	got := readJSON(t, path)
	entry := got["plugins"].(map[string]interface{})["entries"].(map[string]interface{})[OpenClawPluginID].(map[string]interface{})
	cfg := entry["config"].(map[string]interface{})
	assert.Equal(t, "agt_new", cfg["agentId"])
	assert.Equal(t, "evt_new", cfg["agentToken"])
}

// TestOpenClawWriter_Commit_RefusesNonObjectPath asserts the writer
// fails fast (rather than overwriting) when plugins.* exists with a
// wrong type. Users who hand-craft openclaw.json shouldn't lose data.
func TestOpenClawWriter_Commit_RefusesNonObjectPath(t *testing.T) {
	w := newOpenClawWriter()
	dir := t.TempDir()
	path := filepath.Join(dir, "openclaw.json")

	require.NoError(t, os.WriteFile(path, []byte(`{"plugins": "not an object"}`), 0o600))

	plan, err := w.Plan(context.Background(), path)
	require.NoError(t, err)

	_, err = w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "http://localhost:8080",
		AgentID:    "agt_test",
		AgentToken: "evt_test",
	})
	require.Error(t, err, "must refuse to clobber a non-object plugins key")
}
