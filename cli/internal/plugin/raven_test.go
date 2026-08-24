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

// TestRavenPluginIDConsistency guards the id contract between this
// writer and the embedded plugin: raven-plugin.toml's [plugin] id, the
// memory_backends contribution name, and the factory module must match
// RavenPluginID / ravenBackendName / the embedded package layout.
// Raven uses the id as the plugins.config key and warns when the
// install directory name differs from it.
func TestRavenPluginIDConsistency(t *testing.T) {
	raw, err := ravenFS.ReadFile("ravenassets/everme-memory/raven-plugin.toml")
	require.NoError(t, err)
	manifest := string(raw)

	assert.Contains(t, manifest, `id                 = "`+RavenPluginID+`"`,
		"manifest [plugin] id must equal RavenPluginID")
	assert.Contains(t, manifest, `name    = "`+ravenBackendName+`"`,
		"memory_backends contribution name must equal ravenBackendName")
	assert.Contains(t, manifest, `factory = "everme_raven.backend:make_backend"`,
		"factory must reference the embedded everme_raven package")

	// The embedded asset dir name doubles as the on-disk install dir;
	// both must equal the plugin id.
	_, err = ravenFS.ReadFile("ravenassets/" + RavenPluginID + "/raven-plugin.toml")
	assert.NoError(t, err, "embedded asset dir must be named after RavenPluginID")
}

// TestRavenDetector_NoConfig_NotInstalled covers the "Raven not on this
// machine" path. EVERCLI_RAVEN_CONFIG_DIR points at a nonexistent dir
// (unlike hermesHome there is no multi-layer chain — Raven hardcodes
// ~/.raven — so the override IS the honest simulation) and
// EVERCLI_RAVEN_CMD at a nonexistent binary so the test doesn't depend
// on the host's PATH.
func TestRavenDetector_NoConfig_NotInstalled(t *testing.T) {
	t.Setenv("EVERCLI_RAVEN_CONFIG_DIR", filepath.Join(t.TempDir(), "no-such-raven"))
	t.Setenv("EVERCLI_RAVEN_CMD", "/nonexistent/raven-not-on-this-box")

	d, err := ravenDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.Equal(t, PlatformRaven, d.Platform)
	assert.Equal(t, "Raven", d.DisplayName)
	assert.True(t, strings.HasSuffix(d.ConfigPath, "config.json"))
	assert.False(t, d.Installed)
	assert.False(t, d.ConfigExists)
	assert.False(t, d.HasEverMeEntry)
}

// TestRavenDetector_InstalledFromHomeDir confirms that presence of the
// Raven home dir alone (without a `raven` CLI on PATH) flags Raven as
// installed.
func TestRavenDetector_InstalledFromHomeDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("EVERCLI_RAVEN_CONFIG_DIR", home)
	t.Setenv("EVERCLI_RAVEN_CMD", "/nonexistent/raven")

	d, err := ravenDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.True(t, d.Installed, "raven home presence must flag installed")
	assert.False(t, d.HasEverMeEntry)
}

// TestRavenDetector_EntryRequiresFilesAndConfig verifies the dual
// condition: manifest on disk AND memory.backend=everme. Either alone
// is a half-install and must report HasEverMeEntry=false so install
// re-runs repair it.
func TestRavenDetector_EntryRequiresFilesAndConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("EVERCLI_RAVEN_CONFIG_DIR", home)
	t.Setenv("EVERCLI_RAVEN_CMD", "/nonexistent/raven")

	// Config selects everme but no plugin files yet.
	writeRavenTestConfig(t, home, map[string]interface{}{
		"memory": map[string]interface{}{"backend": "everme"},
	})
	d, err := ravenDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.False(t, d.HasEverMeEntry, "config key without plugin files is a half-install")

	// Plugin files land; entry now complete.
	require.NoError(t, writeRavenPluginFiles(filepath.Join(home, "plugins")))
	d, err = ravenDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.True(t, d.HasEverMeEntry)

	// Backend flipped away from everme → not installed anymore.
	writeRavenTestConfig(t, home, map[string]interface{}{
		"memory": map[string]interface{}{"backend": "everos"},
	})
	d, err = ravenDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.False(t, d.HasEverMeEntry, "foreign memory.backend means everme is not active")
}

func TestRavenWriter_LifecycleInterfaces(t *testing.T) {
	var w Writer = newRavenWriter()
	assert.Equal(t, PlatformRaven, w.Platform())
	_, isVerifier := w.(Verifier)
	assert.True(t, isVerifier, "ravenWriter must implement Verifier")
	_, isPreparer := w.(Preparer)
	assert.False(t, isPreparer, "ravenWriter must NOT implement Preparer")
}

// TestRavenWriter_Commit_FreshConfig is the happy path on a machine
// where Raven is installed but config.json doesn't exist yet: plugin
// files land, config is created with backend selection + credentials,
// Verify passes.
func TestRavenWriter_Commit_FreshConfig(t *testing.T) {
	home := t.TempDir()
	cfgPath := filepath.Join(home, "config.json")
	w := newRavenWriter()

	plan, err := w.Plan(context.Background(), cfgPath)
	require.NoError(t, err)
	assert.True(t, plan.WillCreate)
	assert.False(t, plan.WillReplace)
	assert.Empty(t, plan.BackupPath)

	res, err := w.Commit(context.Background(), plan, WriteParams{
		AgentID:    "agt_123",
		AgentToken: "evt_" + strings.Repeat("a", 32),
		APIBaseURL: "https://api.everme.evermind.ai",
	})
	require.NoError(t, err)
	assert.True(t, res.WroteNewEntry)
	assert.Empty(t, res.BackupPath)
	assert.Empty(t, res.NextSteps, "raven install completes headlessly")

	// Plugin files on disk, manifest included.
	for _, name := range ravenFileNames {
		_, statErr := os.Stat(filepath.Join(home, "plugins", RavenPluginID, filepath.FromSlash(name)))
		assert.NoError(t, statErr, name)
	}

	cfg := readRavenTestConfig(t, cfgPath)
	mem := cfg["memory"].(map[string]interface{})
	assert.Equal(t, "everme", mem["backend"])
	entry := cfg["plugins"].(map[string]interface{})["config"].(map[string]interface{})[RavenPluginID].(map[string]interface{})
	assert.Equal(t, "agt_123", entry["agent_id"])
	assert.Equal(t, "evt_"+strings.Repeat("a", 32), entry["agent_token"])
	assert.Equal(t, "https://api.everme.evermind.ai", entry["api_base"])
	assert.Equal(t, float64(1), entry["flush_every_turns"])

	// Fresh token-bearing config lands 0600.
	info, err := os.Stat(cfgPath)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), info.Mode().Perm())

	require.NoError(t, w.Verify(context.Background(), res))
}

func TestRavenWriter_RemovePreservesOtherConfig(t *testing.T) {
	home := t.TempDir()
	cfgPath := filepath.Join(home, "config.json")
	plugins := filepath.Join(home, "plugins", RavenPluginID)
	require.NoError(t, os.MkdirAll(plugins, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(plugins, "raven-plugin.toml"), []byte("id = 'everme-memory'\n"), 0o600))
	cfg := `{"memory":{"backend":"everme","keep":true},"plugins":{"config":{"everme-memory":{"agent_token":"evt_secret"},"other":{"enabled":true}},"disabled":["other"]},"other":"preserve"}`
	require.NoError(t, os.WriteFile(cfgPath, []byte(cfg), 0o600))

	res, err := newRavenWriter().Remove(context.Background(), cfgPath)
	require.NoError(t, err)
	assert.True(t, res.Removed)
	assert.FileExists(t, res.BackupPath)
	got, exists, err := readConfig(cfgPath)
	require.NoError(t, err)
	require.True(t, exists)
	assert.Equal(t, true, got["memory"].(map[string]interface{})["keep"])
	assert.NotEqual(t, "everme", got["memory"].(map[string]interface{})["backend"])
	assert.Contains(t, got["plugins"].(map[string]interface{})["config"].(map[string]interface{}), "other")
	assert.NotContains(t, got["plugins"].(map[string]interface{})["config"].(map[string]interface{}), RavenPluginID)
	assert.Equal(t, "preserve", got["other"])
	assert.NoDirExists(t, plugins)
}

// TestRavenWriter_Commit_PreservesSiblings ensures the patch is
// surgical: provider keys, sibling plugins.config entries, a user's
// plugins.disabled opt-outs of OTHER plugins, and unrelated top-level
// sections must round-trip untouched. A leftover disabled opt-out of
// everme-memory itself is removed (it would silently veto the install).
func TestRavenWriter_Commit_PreservesSiblings(t *testing.T) {
	home := t.TempDir()
	cfgPath := filepath.Join(home, "config.json")
	writeRavenTestConfig(t, home, map[string]interface{}{
		"providers": map[string]interface{}{"anthropic": map[string]interface{}{"api_key": "sk-x"}},
		"memory":    map[string]interface{}{"backend": "everos", "topK": 7},
		"plugins": map[string]interface{}{
			"disabled": []interface{}{"some-other-plugin", RavenPluginID},
			"config": map[string]interface{}{
				"everos-memory": map[string]interface{}{"mode": "embedded"},
			},
		},
	})

	w := newRavenWriter()
	plan, err := w.Plan(context.Background(), cfgPath)
	require.NoError(t, err)
	assert.False(t, plan.WillCreate)
	assert.NotEmpty(t, plan.BackupPath)

	res, err := w.Commit(context.Background(), plan, WriteParams{
		AgentID: "agt_1", AgentToken: "evt_tok", APIBaseURL: "https://api.x",
	})
	require.NoError(t, err)
	assert.Equal(t, cfgPath+backupSuffix, res.BackupPath)

	cfg := readRavenTestConfig(t, cfgPath)
	assert.Equal(t, "sk-x", cfg["providers"].(map[string]interface{})["anthropic"].(map[string]interface{})["api_key"])
	mem := cfg["memory"].(map[string]interface{})
	assert.Equal(t, "everme", mem["backend"], "single slot: everme supersedes everos")
	assert.Equal(t, float64(7), mem["topK"], "sibling memory keys preserved")
	plugins := cfg["plugins"].(map[string]interface{})
	assert.Equal(t, []interface{}{"some-other-plugin"}, plugins["disabled"],
		"our own opt-out removed, others preserved")
	pcfg := plugins["config"].(map[string]interface{})
	assert.Contains(t, pcfg, "everos-memory", "sibling plugin config preserved")
	assert.Contains(t, pcfg, RavenPluginID)

	// Backup carries the pre-install content.
	var backup map[string]interface{}
	raw, err := os.ReadFile(res.BackupPath)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(raw, &backup))
	assert.Equal(t, "everos", backup["memory"].(map[string]interface{})["backend"])
}

// TestRavenWriter_Commit_RefusesNonObjectPath: a scalar where an object
// is expected must abort with an actionable error, never clobber.
func TestRavenWriter_Commit_RefusesNonObjectPath(t *testing.T) {
	home := t.TempDir()
	cfgPath := filepath.Join(home, "config.json")
	writeRavenTestConfig(t, home, map[string]interface{}{
		"memory": "everos", // scalar, not an object
	})

	w := newRavenWriter()
	plan, err := w.Plan(context.Background(), cfgPath)
	require.NoError(t, err)
	_, err = w.Commit(context.Background(), plan, WriteParams{
		AgentID: "a", AgentToken: "t", APIBaseURL: "https://api.x",
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "shape collision")

	// Original config untouched.
	raw, rerr := os.ReadFile(cfgPath)
	require.NoError(t, rerr)
	assert.Contains(t, string(raw), `"memory": "everos"`)
}

// TestRavenWriter_RejectsMalformedJSON: Plan must surface a parse error
// instead of treating garbage as an empty config.
func TestRavenWriter_RejectsMalformedJSON(t *testing.T) {
	home := t.TempDir()
	cfgPath := filepath.Join(home, "config.json")
	require.NoError(t, os.WriteFile(cfgPath, []byte("{not json"), 0o600))

	_, err := newRavenWriter().Plan(context.Background(), cfgPath)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "parse-json")
}

// TestRavenWriter_TOCTOU_ConcurrentEdit: a write between Plan and
// Commit must abort the Commit.
func TestRavenWriter_TOCTOU_ConcurrentEdit(t *testing.T) {
	home := t.TempDir()
	cfgPath := filepath.Join(home, "config.json")
	writeRavenTestConfig(t, home, map[string]interface{}{})

	w := newRavenWriter()
	plan, err := w.Plan(context.Background(), cfgPath)
	require.NoError(t, err)

	// Simulate Raven itself writing between Plan and Commit.
	require.NoError(t, os.WriteFile(cfgPath, []byte(`{"memory":{"backend":"everos"},"pad":"xxxxxxxx"}`), 0o600))

	_, err = w.Commit(context.Background(), plan, WriteParams{
		AgentID: "a", AgentToken: "t", APIBaseURL: "https://api.x",
	})
	require.Error(t, err)
}

// TestRavenWriter_Verify_HalfInstall: Verify fails when the config key
// is present but plugin files are missing (and vice versa).
func TestRavenWriter_Verify_HalfInstall(t *testing.T) {
	home := t.TempDir()
	cfgPath := filepath.Join(home, "config.json")
	writeRavenTestConfig(t, home, map[string]interface{}{
		"memory": map[string]interface{}{"backend": "everme"},
	})
	w := newRavenWriter()
	res := &WriteResult{Platform: PlatformRaven, ConfigPath: cfgPath}
	require.Error(t, w.Verify(context.Background(), res), "missing plugin files must fail Verify")

	require.NoError(t, writeRavenPluginFiles(filepath.Join(home, "plugins")))
	require.NoError(t, w.Verify(context.Background(), res))

	writeRavenTestConfig(t, home, map[string]interface{}{
		"memory": map[string]interface{}{"backend": "everos"},
	})
	require.Error(t, w.Verify(context.Background(), res), "foreign backend must fail Verify")
}

// ---- helpers ---------------------------------------------------------

func writeRavenTestConfig(t *testing.T, home string, cfg map[string]interface{}) {
	t.Helper()
	raw, err := json.MarshalIndent(cfg, "", "  ")
	require.NoError(t, err)
	require.NoError(t, os.MkdirAll(home, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(home, "config.json"), raw, 0o600))
}

func readRavenTestConfig(t *testing.T, path string) map[string]interface{} {
	t.Helper()
	raw, err := os.ReadFile(path)
	require.NoError(t, err)
	var cfg map[string]interface{}
	require.NoError(t, json.Unmarshal(raw, &cfg))
	return cfg
}
