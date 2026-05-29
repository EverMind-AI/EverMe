package plugin

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestCodexMarketplaceStructure guards the on-disk layout of the
// codex marketplace (repo root) against silent regressions. The real
// `codex plugin marketplace add` smoke test exercises the same files
// but requires the codex CLI installed on the box — this test runs
// in pure `go test` with zero external dependencies, so it catches
// renames/moves/missing files immediately on any CI runner.
//
// Specifically pinned (W1 spike captured these as the load-bearing
// invariants — they don't show up in any other test today):
//   - manifest sits at `.agents/plugins/marketplace.json`, NOT at root
//   - `plugins[0].source.path` points at `./plugins/everme` so the
//     marketplace.json and the per-plugin tree agree
//   - per-plugin manifest at `plugins/everme/.codex-plugin/plugin.json`
//     carries the rich interface schema (displayName + category) that
//     Codex's UI actually reads
//   - skill markdown ships at `plugins/everme/skills/everme-memory/SKILL.md`
//     because plugin.json's `skills` field is "./skills/" (a directory,
//     not a file path)
func TestCodexMarketplaceStructure(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	require.True(t, ok, "runtime.Caller failed — cannot locate test source")
	// The marketplace root is the repo root: EverMind-AI/EverMe is a
	// dedicated mirror whose root IS the marketplace (manifest at
	// .agents/plugins/marketplace.json), and evercli adds it with a
	// full clone (no --sparse). The monorepo mirrors that same root
	// layout so the published tree matches 1:1.
	marketplaceRoot := filepath.Join(filepath.Dir(thisFile), "..", "..", "..")

	// 1. Marketplace manifest must live under .agents/plugins/.
	manifestPath := filepath.Join(marketplaceRoot, ".agents", "plugins", "marketplace.json")
	raw, err := os.ReadFile(manifestPath)
	require.NoError(t, err, "marketplace.json must exist at %s (Codex CLI rejects any other location with `marketplace root does not contain a supported manifest`)", manifestPath)

	var manifest struct {
		Name      string `json:"name"`
		Interface struct {
			DisplayName string `json:"displayName"`
		} `json:"interface"`
		Plugins []struct {
			Name   string `json:"name"`
			Source struct {
				Source string `json:"source"`
				Path   string `json:"path"`
			} `json:"source"`
			Policy struct {
				Installation   string `json:"installation"`
				Authentication string `json:"authentication"`
			} `json:"policy"`
			Category string `json:"category"`
		} `json:"plugins"`
	}
	require.NoError(t, json.Unmarshal(raw, &manifest), "marketplace.json must parse as JSON")

	// 2. Top-level shape — Codex's loader reads .name and .interface.displayName.
	assert.Equal(t, "everme", manifest.Name, "marketplace name pins evercli's [marketplaces.everme] section name")
	assert.Equal(t, "EverMe", manifest.Interface.DisplayName, "displayName surfaces in Codex's marketplace UI")

	// 3. Exactly one plugin (the EverMe Codex skill).
	require.Len(t, manifest.Plugins, 1, "marketplace ships exactly one plugin (everme); if we add another, update evercli's codexPluginSpec accordingly")
	p := manifest.Plugins[0]
	assert.Equal(t, "everme", p.Name)
	assert.Equal(t, "local", p.Source.Source, "plugins[].source.source must be `local` — Codex resolves the path relative to the marketplace cache root, both for dev (local dir) and prod (full GitHub clone)")
	assert.Equal(t, "./plugins/everme", p.Source.Path,
		"plugins[].source.path must agree with the on-disk plugin dir; if you move plugins/everme/ this test fails before users do")
	assert.Equal(t, "AVAILABLE", p.Policy.Installation, "users must be able to install; PRIVATE / SUPPRESSED would hide the plugin")
	assert.Equal(t, "ON_INSTALL", p.Policy.Authentication, "auth gate matches how Codex's bundled plugins gate first-run setup")
	assert.NotEmpty(t, p.Category, "category drives the Codex UI grouping; empty would render under 'Other'")

	// 4. Per-plugin manifest must live at the source.path's .codex-plugin/ subdir.
	pluginRoot := filepath.Join(marketplaceRoot, "plugins", "everme")
	pluginManifestPath := filepath.Join(pluginRoot, ".codex-plugin", "plugin.json")
	pluginRaw, err := os.ReadFile(pluginManifestPath)
	require.NoError(t, err, "per-plugin manifest must exist at %s — Codex won't load the plugin without it", pluginManifestPath)

	var plugin struct {
		Name    string `json:"name"`
		Version string `json:"version"`
		Author  struct {
			Name string `json:"name"`
		} `json:"author"`
		Skills    string `json:"skills"`
		Interface struct {
			DisplayName string `json:"displayName"`
			Category    string `json:"category"`
		} `json:"interface"`
	}
	require.NoError(t, json.Unmarshal(pluginRaw, &plugin), "plugin.json must parse as JSON")

	assert.Equal(t, "everme", plugin.Name)
	assert.NotEmpty(t, plugin.Version, "Codex shows version in the plugin detail UI; empty would render odd")
	// author must be an OBJECT not a string — Codex's bundled plugins (chrome, latex,
	// computer-use) all use the object form, and `author: "string"` got the
	// initial draft of this manifest rejected during W1 spike.
	assert.NotEmpty(t, plugin.Author.Name, "plugin.author must be the object form {name: ...} — string form is silently malformed")
	// `skills` is a directory path string (not an array). Codex enumerates
	// every SKILL.md under it; an array shape ships but doesn't surface the
	// skills at runtime.
	assert.Equal(t, "./skills/", plugin.Skills, "skills must be a directory path string with trailing slash, matching the openai-bundled convention")
	assert.NotEmpty(t, plugin.Interface.DisplayName)
	assert.NotEmpty(t, plugin.Interface.Category)

	// Capabilities must NOT advertise "Write": the Codex App's LLM
	// tool surface biases toward MCP Resources (read-only), so users
	// who see "Write" in the marketplace UI then read in SKILL.md
	// that auto-save isn't supported get burned by the mismatch.
	// SKILL.md is the source of truth on what the plugin can do
	// inside Codex; capabilities must agree.
	var caps struct {
		Interface struct {
			Capabilities []string `json:"capabilities"`
		} `json:"interface"`
	}
	require.NoError(t, json.Unmarshal(pluginRaw, &caps))
	for _, c := range caps.Interface.Capabilities {
		assert.NotEqual(t, "Write", c,
			"plugin.json must not declare Write capability — SKILL.md tells the model auto-save isn't available, and marketplace UI advertising Write would mislead users")
	}

	// 5. The skill referenced by plugin.json must actually exist on disk.
	skillPath := filepath.Join(pluginRoot, "skills", "everme-memory", "SKILL.md")
	_, err = os.Stat(skillPath)
	require.NoError(t, err, "SKILL.md must exist at %s — plugin.json's skills=./skills/ is a directory scan, so the file is the only thing carrying the protocol Codex shows to the LLM", skillPath)
}

// TestCodexMarketplace_ConstantsAgreeWithManifest pins that the Go
// constants the codex writer hardcodes for marketplace registration
// agree with what marketplace.json actually advertises. If somebody
// renames the manifest's `.name` field or the plugin name but forgets
// to update codex.go, evercli will write a [plugins."<old>@<old>"]
// section that Codex can't resolve.
func TestCodexMarketplace_ConstantsAgreeWithManifest(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	require.True(t, ok)
	manifestPath := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", ".agents", "plugins", "marketplace.json")
	raw, err := os.ReadFile(manifestPath)
	require.NoError(t, err)

	var m struct {
		Name    string `json:"name"`
		Plugins []struct {
			Name string `json:"name"`
		} `json:"plugins"`
	}
	require.NoError(t, json.Unmarshal(raw, &m))

	assert.Equal(t, codexMarketplaceName, m.Name,
		"codexMarketplaceName must equal marketplace.json:.name — drift breaks evercli's [marketplaces.<name>] write target")
	require.NotEmpty(t, m.Plugins)
	assert.Equal(t, codexMcpEntryName, m.Plugins[0].Name,
		"codexMcpEntryName must equal marketplace.json:.plugins[0].name — drift breaks the everme@everme plugin spec")
}
