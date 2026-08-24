package plugin

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestKimicodeEnvFileHeaderNamesPlatform locks the fix for the everme.env
// header naming the wrong host: a kimicode install must reference kimicode /
// Kimi Code, never claude-code.
func TestKimicodeEnvFileHeaderNamesPlatform(t *testing.T) {
	body, err := buildEnvFileBody(PlatformKimiCode, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_abc",
		AgentToken: "evt_xyz",
	})
	require.NoError(t, err)
	assert.Contains(t, body, "evercli plugin install kimicode")
	assert.Contains(t, body, "/plugins remove everme") // Kimi Code uninstall
	assert.NotContains(t, body, "claude-code")
	assert.NotContains(t, body, "claude plugin uninstall")
}

func TestKimiCodeWriter_RemoveCleansEverMeOwnedFiles(t *testing.T) {
	home := t.TempDir()
	envPath := filepath.Join(home, "everme.env")
	stage := filepath.Join(home, "everme")
	require.NoError(t, os.WriteFile(envPath, []byte("EVERME_AGENT_TOKEN=evt_secret\n"), 0o600))
	require.NoError(t, os.MkdirAll(stage, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(stage, "kimi.plugin.json"), []byte("{}"), 0o600))
	res, err := newKimiCodeWriter().Remove(context.Background(), envPath)
	require.NoError(t, err)
	assert.True(t, res.Removed)
	assert.FileExists(t, res.BackupPath)
	assert.NoFileExists(t, envPath)
	assert.NoDirExists(t, stage)
}

func TestKimiCodeWriter_UninstallNextStepsExplainManagedRegistry(t *testing.T) {
	steps := newKimiCodeWriter().UninstallNextSteps()
	require.Len(t, steps, 1)
	assert.Contains(t, steps[0], "/plugins remove everme")
}

// TestKimicodePluginSource_PriorityChain locks the resolution order of
// kimicodePluginSource, which now mirrors claude-code's pluginSourceSpec:
//
//  1. struct-injected pluginSource (test-only)
//  2. EVERCLI_KIMICODE_PLUGIN_SOURCE env override
//  3. globalNpmKimicodePath() — probe `npm root -g`/@everme/kimicode
//  4. ensureNpmKimicodeInstalled() — `npm install -g @everme/kimicode`, retry probe
//
// Layers 3/4 need a working npm and are exercised by end-to-end install
// verification. The unit tests below cover layers 1 and 2 plus the
// npm-missing fail-hard path and the Plan "would install" preview path —
// enough to catch priority-chain regressions without a real npm registry.
func TestKimicodePluginSource_PriorityChain(t *testing.T) {
	// (1) Struct injection wins over env.
	t.Run("structInjectionBeatsEnv", func(t *testing.T) {
		t.Setenv("EVERCLI_KIMICODE_PLUGIN_SOURCE", "/abs/from/env")
		w := &kimiCodeWriter{pluginSource: "/abs/from/struct"}
		got, resolved, err := w.kimicodePluginSource(context.Background(), false)
		require.NoError(t, err)
		assert.Equal(t, "/abs/from/struct", got)
		assert.True(t, resolved)
	})

	// (2) Env override wins over the npm probe.
	t.Run("envBeatsNpmProbe", func(t *testing.T) {
		t.Setenv("EVERCLI_KIMICODE_PLUGIN_SOURCE", "/abs/from/env")
		w := &kimiCodeWriter{}
		got, resolved, err := w.kimicodePluginSource(context.Background(), false)
		require.NoError(t, err)
		assert.Equal(t, "/abs/from/env", got)
		assert.True(t, resolved)
	})

	// (3) Commit path (installIfMissing=true) with no env and no npm on PATH:
	// FAIL-HARD with a clear npm error rather than a silent degrade. The
	// global package is the bundle source; with no bundle there is nothing
	// to stage.
	t.Run("missingNpmIsErroredHard", func(t *testing.T) {
		t.Setenv("EVERCLI_KIMICODE_PLUGIN_SOURCE", "")
		t.Setenv("PATH", "")
		w := &kimiCodeWriter{}
		_, _, err := w.kimicodePluginSource(context.Background(), true)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "npm")
	})

	// (4) Plan path (installIfMissing=false) with no env and no npm returns
	// ("", false, nil) — the caller surfaces a "would install" preview
	// rather than aborting Plan (Writer contract: Plan has no side effects).
	t.Run("planSkipsInstallAndReturnsUnresolved", func(t *testing.T) {
		t.Setenv("EVERCLI_KIMICODE_PLUGIN_SOURCE", "")
		t.Setenv("PATH", "")
		w := &kimiCodeWriter{}
		got, resolved, err := w.kimicodePluginSource(context.Background(), false)
		require.NoError(t, err)
		assert.Equal(t, "", got)
		assert.False(t, resolved)
	})
}

// neutralizeKimicodeEnv points the config-dir override at a fresh empty
// temp dir and pins KIMI_CODE_HOME / EVERCLI_KIMICODE_CMD at nonexistent
// paths so a dev machine with a real Kimi Code install can't leak a true
// "installed" signal into the not-installed tests. Returns the home dir.
func neutralizeKimicodeEnv(t *testing.T) string {
	t.Helper()
	home := filepath.Join(t.TempDir(), "kimi-home")
	t.Setenv("EVERCLI_KIMICODE_CONFIG_DIR", home)
	t.Setenv("KIMI_CODE_HOME", filepath.Join(t.TempDir(), "nonexistent-kimi"))
	// EVERCLI_KIMICODE_CMD points kimiCommand() at a binary name that
	// exec.LookPath will never resolve, so the PATH heuristic is neutral.
	t.Setenv("EVERCLI_KIMICODE_CMD", filepath.Join(t.TempDir(), "no-such-kimi"))
	t.Setenv("HOME", t.TempDir())
	return home
}

// writeFakeBundle creates a minimal Kimi Code plugin bundle on disk with a
// manifest, one nested hooks file, a node_modules dir (so the copy includes
// it and the npm-install branch is skipped — no network in tests), and a
// .git dir (which must be skipped). Points EVERCLI_KIMICODE_PLUGIN_SOURCE at
// it. Returns the bundle dir.
func writeFakeBundle(t *testing.T) string {
	t.Helper()
	bundle := filepath.Join(t.TempDir(), "bundle")
	require.NoError(t, os.MkdirAll(filepath.Join(bundle, "hooks", "scripts"), 0o755))
	require.NoError(t, os.WriteFile(
		filepath.Join(bundle, "kimi.plugin.json"),
		[]byte(`{"name":"everme","version":"0.1.0"}`), 0o644))
	require.NoError(t, os.WriteFile(
		filepath.Join(bundle, "hooks", "scripts", "x.mjs"),
		[]byte("export const x = 1;\n"), 0o644))
	// node_modules IS copied (hooks need runtime deps) and its presence
	// makes Commit skip the npm-install branch — so tests never hit the
	// network.
	require.NoError(t, os.MkdirAll(filepath.Join(bundle, "node_modules", "junk"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(bundle, "node_modules", "junk", "a.js"), []byte("x"), 0o644))
	// .git must be skipped by the recursive copy.
	require.NoError(t, os.MkdirAll(filepath.Join(bundle, ".git"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(bundle, ".git", "HEAD"), []byte("ref"), 0o644))
	t.Setenv("EVERCLI_KIMICODE_PLUGIN_SOURCE", bundle)
	return bundle
}

// ---- detector -------------------------------------------------------

func TestKimiCodeDetector_NotInstalled(t *testing.T) {
	neutralizeKimicodeEnv(t)
	t.Setenv("PATH", t.TempDir()) // no kimi on PATH

	d, err := kimiCodeDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.Equal(t, PlatformKimiCode, d.Platform)
	assert.Equal(t, "Kimi Code", d.DisplayName)
	assert.False(t, d.Installed, "empty home + no kimi CLI => not installed")
	assert.False(t, d.ConfigExists)
	assert.False(t, d.HasEverMeEntry)
	// ConfigPath now points at <home>/everme.env.
	assert.Equal(t, "everme.env", filepath.Base(d.ConfigPath))
}

func TestKimiCodeDetector_HomeExistsNoEverme(t *testing.T) {
	home := neutralizeKimicodeEnv(t)
	t.Setenv("PATH", t.TempDir())
	require.NoError(t, os.MkdirAll(home, 0o700)) // home dir exists

	d, err := kimiCodeDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.True(t, d.Installed, "home dir exists => installed")
	assert.False(t, d.ConfigExists)
	assert.False(t, d.HasEverMeEntry)
}

func TestKimiCodeDetector_HasEverMeEntryAfterCommit(t *testing.T) {
	home := neutralizeKimicodeEnv(t)
	t.Setenv("PATH", t.TempDir())
	writeFakeBundle(t)

	w := newKimiCodeWriter()
	plan, err := w.Plan(context.Background(), kimicodeEnvPath(home))
	require.NoError(t, err)
	_, err = w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_kc",
		AgentToken: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	})
	require.NoError(t, err)

	d, err := kimiCodeDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.True(t, d.Installed)
	assert.True(t, d.ConfigExists)
	assert.True(t, d.HasEverMeEntry, "after Commit everme.env + staged bundle exist")
}

// ---- writer ---------------------------------------------------------

func TestKimiCodeWriter_PlanCommitRoundTrip(t *testing.T) {
	home := neutralizeKimicodeEnv(t)
	writeFakeBundle(t)

	w := newKimiCodeWriter()
	plan, err := w.Plan(context.Background(), kimicodeEnvPath(home))
	require.NoError(t, err)
	assert.True(t, plan.WillCreate, "fresh home => everme.env will be created")
	// PreviewEntry surfaces the stage dir + register hint.
	assert.Equal(t, filepath.Join(home, "everme"), plan.PreviewEntry["stageDir"])
	assert.Contains(t, plan.PreviewEntry["registerHint"], "/plugins install")

	res, err := w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_kc",
		AgentToken: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	})
	require.NoError(t, err)
	assert.True(t, res.WroteNewEntry)

	stage := filepath.Join(home, "everme")

	// Manifest copied into the stage dir.
	_, statErr := os.Stat(filepath.Join(stage, "kimi.plugin.json"))
	require.NoError(t, statErr, "kimi.plugin.json must be copied")

	// Nested hooks file copied.
	_, statErr = os.Stat(filepath.Join(stage, "hooks", "scripts", "x.mjs"))
	require.NoError(t, statErr, "nested hooks file must be copied")

	// node_modules IS copied (hooks need runtime deps).
	_, statErr = os.Stat(filepath.Join(stage, "node_modules", "junk", "a.js"))
	require.NoError(t, statErr, "node_modules must be copied")

	// .git skipped.
	_, statErr = os.Stat(filepath.Join(stage, ".git"))
	assert.Error(t, statErr, ".git must be skipped")

	// everme.env carries the token, mode 0600.
	envBody, rerr := os.ReadFile(filepath.Join(home, "everme.env"))
	require.NoError(t, rerr)
	assert.Contains(t, string(envBody), "EVERME_AGENT_TOKEN=evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	info, _ := os.Stat(filepath.Join(home, "everme.env"))
	assert.Equal(t, os.FileMode(0o600), info.Mode().Perm())

	// evercli must NOT write installed.json or plugins/managed anymore.
	_, statErr = os.Stat(filepath.Join(home, "plugins", "installed.json"))
	assert.Error(t, statErr, "evercli must not write installed.json")
	_, statErr = os.Stat(filepath.Join(home, "plugins", "managed"))
	assert.Error(t, statErr, "evercli must not write plugins/managed")
}

// Commit must return a NextSteps entry telling the user to finish
// registration inside the Kimi Code TUI — evercli only stages the bundle;
// there is no headless install/register command.
func TestKimiCodeWriter_CommitReturnsRegisterNextStep(t *testing.T) {
	home := neutralizeKimicodeEnv(t)
	writeFakeBundle(t)

	w := newKimiCodeWriter()
	plan, err := w.Plan(context.Background(), kimicodeEnvPath(home))
	require.NoError(t, err)
	res, err := w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_kc",
		AgentToken: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	})
	require.NoError(t, err)

	stageDir := filepath.Join(home, "everme")
	require.NotEmpty(t, res.NextSteps, "Commit must return a register next-step")
	joined := strings.Join(res.NextSteps, "\n")
	assert.Contains(t, joined, "/plugins install "+stageDir, "must name the exact TUI register command with the staged dir")
	assert.Contains(t, joined, "no headless install", "must clarify why registration is manual")
}

// A re-install (existing everme.env) replaces the staged bundle cleanly and
// reports WroteNewEntry=false.
func TestKimiCodeWriter_ReinstallReplaces(t *testing.T) {
	home := neutralizeKimicodeEnv(t)
	writeFakeBundle(t)
	envPath := kimicodeEnvPath(home)

	w := newKimiCodeWriter()

	// First install.
	plan, err := w.Plan(context.Background(), envPath)
	require.NoError(t, err)
	_, err = w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_kc",
		AgentToken: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	})
	require.NoError(t, err)

	// Drop a stale file into the staged dir; the wipe-then-copy must remove it.
	stale := filepath.Join(home, "everme", "stale.txt")
	require.NoError(t, os.WriteFile(stale, []byte("old"), 0o644))

	// Second install over the existing footprint.
	plan2, err := w.Plan(context.Background(), envPath)
	require.NoError(t, err)
	assert.True(t, plan2.WillReplace, "pre-existing everme.env => replace")
	res2, err := w.Commit(context.Background(), plan2, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_kc",
		AgentToken: "evt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	})
	require.NoError(t, err)
	assert.False(t, res2.WroteNewEntry, "re-install over existing env => not a new entry")

	_, statErr := os.Stat(stale)
	assert.Error(t, statErr, "stale file must be wiped on re-install")
}

// ---- verify ---------------------------------------------------------

func TestKimiCodeWriter_VerifyAfterCommit(t *testing.T) {
	home := neutralizeKimicodeEnv(t)
	writeFakeBundle(t)

	w := newKimiCodeWriter()
	plan, err := w.Plan(context.Background(), kimicodeEnvPath(home))
	require.NoError(t, err)
	res, err := w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_kc",
		AgentToken: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	})
	require.NoError(t, err)

	require.NoError(t, w.Verify(context.Background(), res), "Verify must pass after a successful Commit")
}

func TestKimiCodeWriter_VerifyFailsOnFreshDir(t *testing.T) {
	home := neutralizeKimicodeEnv(t)
	w := newKimiCodeWriter()
	err := w.Verify(context.Background(), &WriteResult{
		Platform:   PlatformKimiCode,
		ConfigPath: kimicodeEnvPath(home),
	})
	assert.Error(t, err, "Verify must fail when nothing is installed")
}

// Plan must NOT fail when no bundle source resolves: it previews the
// deferred `npm install -g @everme/kimicode` (run at Commit) rather than
// aborting. Mirrors claude-code's Plan preview.
func TestKimiCodeWriter_PlanPreviewsInstallWithoutBundleSource(t *testing.T) {
	home := neutralizeKimicodeEnv(t)
	t.Setenv("EVERCLI_KIMICODE_PLUGIN_SOURCE", "")
	t.Setenv("PATH", t.TempDir()) // no npm => npm root -g unresolvable

	w := newKimiCodeWriter()
	plan, err := w.Plan(context.Background(), kimicodeEnvPath(home))
	require.NoError(t, err, "Plan must preview the install, not fail, when the bundle is unresolved")
	assert.Equal(t, "<would npm install -g @everme/kimicode at Commit>", plan.PreviewEntry["pluginSource"])
}
