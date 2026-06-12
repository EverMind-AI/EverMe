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

// TestHermesDetector_NoConfig_NotInstalled covers the "Hermes not on
// this machine" path: no `hermes` on PATH, no ~/.hermes/ dir, no
// config.yaml. Detector must still return a usable Detection with
// ConfigPath populated so install can offer the actionable
// "install Hermes first" hint.
//
// Note: this test does NOT set EVERCLI_HERMES_CONFIG_DIR because that
// env is layer 1 of hermesHome's priority chain — setting it to a
// t.TempDir() (which always exists) would short-circuit hermesHome
// and make Detector report Installed=true via the home-exists branch.
// Letting hermesHome fall through all the way to $HOME/.hermes
// (which doesn't exist in our fakeHome) is the honest expression of
// "Hermes isn't on this box".
func TestHermesDetector_NoConfig_NotInstalled(t *testing.T) {
	t.Setenv("EVERCLI_HERMES_CONFIG_DIR", "")
	t.Setenv("HERMES_HOME", "")
	fakeHome := t.TempDir()
	t.Setenv("HOME", fakeHome)
	// Point CMD at a path that doesn't exist so exec.LookPath fails
	// even on machines where the real `hermes` CLI is installed —
	// the test must not depend on the host's PATH.
	t.Setenv("EVERCLI_HERMES_CMD", "/nonexistent/hermes-not-on-this-box")

	d, err := hermesDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.Equal(t, PlatformHermes, d.Platform)
	assert.Equal(t, "Hermes", d.DisplayName)
	assert.Equal(t, filepath.Join(fakeHome, ".hermes", "config.yaml"), d.ConfigPath)
	assert.False(t, d.Installed)
	assert.False(t, d.ConfigExists)
	assert.False(t, d.HasEverMeEntry)
}

// TestHermesDetector_InstalledFromHomeDir confirms that presence of
// ~/.hermes/ alone (without a `hermes` CLI on PATH) flags Hermes as
// installed. Hermes's installer creates the home dir before linking
// the CLI shim on some setups, so the dir-based heuristic must hold.
func TestHermesDetector_InstalledFromHomeDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("EVERCLI_HERMES_CONFIG_DIR", t.TempDir())
	t.Setenv("EVERCLI_HERMES_CMD", "/nonexistent/hermes")
	require.NoError(t, os.MkdirAll(filepath.Join(home, ".hermes"), 0o700))

	d, err := hermesDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.True(t, d.Installed, "~/.hermes/ presence must flag installed")
}

// TestHermesDetector_ConfigWithoutEverMe_HasOther verifies the
// negative case: another mcp server (n8n, etc.) present, but no
// everme entry → HasEverMeEntry=false. Regression guard against
// "matches any mcp_servers child" bug.
func TestHermesDetector_ConfigWithoutEverMe_HasOther(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("EVERCLI_HERMES_CONFIG_DIR", dir)
	t.Setenv("HOME", t.TempDir())
	t.Setenv("EVERCLI_HERMES_CMD", "/nonexistent/hermes")

	path := filepath.Join(dir, "config.yaml")
	require.NoError(t, os.WriteFile(path, []byte("mcp_servers:\n  n8n:\n    command: python\n"), 0o600))

	d, err := hermesDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.True(t, d.ConfigExists)
	assert.False(t, d.HasEverMeEntry)
}

// TestHermesHome_Priority_HermesHomeEnv is the P1 regression guard
// for the env-var layer of hermesHome's priority chain: HERMES_HOME
// MUST be honoured over the ~/.hermes fallback. Without this, users
// with a non-default Hermes home would have evercli register an agent
// + mint a token, then write the wrong YAML file — Hermes would
// silently never load EverMe while evercli reports success.
func TestHermesHome_Priority_HermesHomeEnv(t *testing.T) {
	// EVERCLI_HERMES_CONFIG_DIR is layer 1 and would mask HERMES_HOME;
	// unset it explicitly so this test exercises layer 2.
	t.Setenv("EVERCLI_HERMES_CONFIG_DIR", "")
	customHome := filepath.Join(t.TempDir(), "custom-hermes")
	t.Setenv("HERMES_HOME", customHome)
	// Point CMD at /nonexistent so probeHermesConfigPathCLI (layer 3)
	// degrades and would otherwise hit the ~/.hermes fallback (layer 4).
	t.Setenv("EVERCLI_HERMES_CMD", "/nonexistent/hermes")
	t.Setenv("HOME", t.TempDir())

	home, err := hermesHome()
	require.NoError(t, err)
	assert.Equal(t, customHome, home, "HERMES_HOME must win over ~/.hermes fallback")

	cfg, err := hermesConfigPath()
	require.NoError(t, err)
	assert.Equal(t, filepath.Join(customHome, "config.yaml"), cfg)
}

// TestHermesHome_Priority_CLIPath is the P1 regression guard for the
// `hermes config path` CLI layer. When the user has Hermes on PATH
// but neither override is set, we MUST consult the CLI rather than
// hard-guessing ~/.hermes. The stub writes a path to stdout and
// hermesHome() should strip the basename and return that dir.
func TestHermesHome_Priority_CLIPath(t *testing.T) {
	if runtimeGOOS() == "windows" {
		t.Skip("shell-script stub doesn't execute on Windows")
	}
	t.Setenv("EVERCLI_HERMES_CONFIG_DIR", "")
	t.Setenv("HERMES_HOME", "")
	t.Setenv("HOME", t.TempDir())

	stubDir := t.TempDir()
	stub := filepath.Join(stubDir, "hermes")
	customHome := filepath.Join(t.TempDir(), "alt-hermes")
	customCfg := filepath.Join(customHome, "config.yaml")
	body := []byte(`#!/bin/sh
# evercli test stub for ` + "`hermes config path`" + `
if [ "$1" = "config" ] && [ "$2" = "path" ]; then
  printf '%s\n' "` + customCfg + `"
  exit 0
fi
exit 1
`)
	require.NoError(t, os.WriteFile(stub, body, 0o755))
	t.Setenv("EVERCLI_HERMES_CMD", stub)

	home, err := hermesHome()
	require.NoError(t, err)
	assert.Equal(t, customHome, home, "`hermes config path` output must resolve home")
}

// TestHermesHome_Priority_FallbackHome is the bottom of the priority
// chain: nothing set, no CLI → ~/.hermes. Pins that the fallback
// fires when (and only when) none of the higher-priority signals
// resolve. This is the path Hermes maintainers' rule treats as the
// "last resort" — present here so the fallback continues to work for
// vanilla setups even after we wire the rest of the chain.
func TestHermesHome_Priority_FallbackHome(t *testing.T) {
	t.Setenv("EVERCLI_HERMES_CONFIG_DIR", "")
	t.Setenv("HERMES_HOME", "")
	t.Setenv("EVERCLI_HERMES_CMD", "/nonexistent/hermes")
	fakeHome := t.TempDir()
	t.Setenv("HOME", fakeHome)

	home, err := hermesHome()
	require.NoError(t, err)
	assert.Equal(t, filepath.Join(fakeHome, ".hermes"), home, "fallback to $HOME/.hermes")
}

// TestHermesWriter_LifecycleInterfaces pins the Preparer/Verifier
// shape: Hermes has no marketplace step (unlike Codex) so Preparer
// must remain unimplemented; Verify is the post-Commit yaml round-
// trip check and must be wired.
func TestHermesWriter_LifecycleInterfaces(t *testing.T) {
	w := newHermesWriter()
	_, isPreparer := any(w).(Preparer)
	assert.False(t, isPreparer, "hermes has no pre-mint marketplace step; Preparer must NOT be implemented")
	_, isVerifier := any(w).(Verifier)
	assert.True(t, isVerifier, "hermes writer must implement Verifier for post-Commit yaml round-trip check")
}

// TestHermesWriter_RejectsMalformedYAML — bad YAML must surface a
// structured parse error, not silently overwrite.
func TestHermesWriter_RejectsMalformedYAML(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	require.NoError(t, os.WriteFile(path, []byte("agent: {unclosed\n"), 0o600))

	w := newHermesWriter()
	_, err := w.Plan(context.Background(), path)
	require.Error(t, err, "Plan must surface YAML parse error rather than overwrite")
}

// TestHermesWriter_TOCTOU_ConcurrentEdit — Commit must refuse when
// the file changed between Plan and Commit (mirrors mcp.go's
// assertNoConcurrentChange invariant). Hermes itself may rewrite
// config.yaml in the background (`hermes config migrate`), so this
// guard is load-bearing.
func TestHermesWriter_TOCTOU_ConcurrentEdit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	require.NoError(t, os.WriteFile(path, []byte("agent:\n  max_turns: 90\n"), 0o600))

	w := newHermesWriter()
	plan, err := w.Plan(context.Background(), path)
	require.NoError(t, err)

	// Simulate Hermes / a sibling evercli editing the file between Plan and Commit.
	// We need a perceptible mtime delta — bump the snapshot back by 2 seconds
	// to dodge sub-second filesystem mtime resolution on some platforms.
	plan.SnapshotModTime -= int64(2e9)

	_, err = w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_test",
		AgentToken: "evt_test",
	})
	require.Error(t, err, "Commit must refuse when (mtime, size) shifted since Plan")
}

// TestHermesWriter_Verify_ConfigVanished — Verify must surface a
// structured error if the config file disappeared after Commit
// (uninstall race, user `rm`, etc.). Mirrors codexWriter.Verify.
func TestHermesWriter_Verify_ConfigVanished(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")

	w := newHermesWriter()
	err := w.Verify(context.Background(), &WriteResult{
		Platform:   PlatformHermes,
		ConfigPath: path,
	})
	require.Error(t, err, "Verify must fail when config file is missing")
}

func TestHermesCommitWritesProviderAndRemovesMcp(t *testing.T) {
	home := t.TempDir()
	t.Setenv("EVERCLI_HERMES_CONFIG_DIR", home)
	cfgPath := filepath.Join(home, "config.yaml")
	// Seed an existing config with a legacy mcp_servers.everme entry + a sibling.
	seed := "" +
		"model: gpt-4\n" +
		"mcp_servers:\n" +
		"  everme:\n" +
		"    command: npx\n" +
		"    env:\n" +
		"      EVERME_AGENT_TOKEN: evt_old\n" +
		"  other:\n" +
		"    command: foo\n"
	if err := os.WriteFile(cfgPath, []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}

	w := newHermesWriter()
	plan, err := w.Plan(context.Background(), cfgPath)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	res, err := w.Commit(context.Background(), plan, WriteParams{
		AgentID: "agt_new", AgentToken: "evt_new", APIBaseURL: "https://api.everme.evermind.ai",
	})
	if err != nil {
		t.Fatalf("commit: %v", err)
	}

	// 1. provider files written
	if _, err := os.Stat(filepath.Join(home, "plugins", "everme", "__init__.py")); err != nil {
		t.Fatalf("provider not written: %v", err)
	}
	// 2. everme.env written 0600 with token
	envPath := filepath.Join(home, "everme.env")
	info, err := os.Stat(envPath)
	if err != nil {
		t.Fatalf("everme.env missing: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("everme.env perm = %o, want 600", info.Mode().Perm())
	}
	envBody, _ := os.ReadFile(envPath)
	if !strings.Contains(string(envBody), "EVERME_AGENT_TOKEN=evt_new") {
		t.Fatalf("everme.env missing token: %s", envBody)
	}
	// 3. config.yaml: memory.provider=everme, mcp_servers.everme removed, sibling kept
	cfg, _, _ := readHermesConfig(cfgPath)
	mem, _ := cfg["memory"].(map[string]interface{})
	if mem == nil || mem["provider"] != "everme" {
		t.Fatalf("memory.provider not set: %#v", cfg["memory"])
	}
	servers, _ := cfg["mcp_servers"].(map[string]interface{})
	if _, exists := servers["everme"]; exists {
		t.Fatal("legacy mcp_servers.everme not removed")
	}
	if _, exists := servers["other"]; !exists {
		t.Fatal("sibling mcp_servers.other clobbered")
	}
	_ = res
}

func TestHermesDetectProviderInstalled(t *testing.T) {
	home := t.TempDir()
	t.Setenv("EVERCLI_HERMES_CONFIG_DIR", home)
	// Write provider files + memory.provider=everme.
	if err := writeProviderFiles(filepath.Join(home, "plugins")); err != nil {
		t.Fatal(err)
	}
	cfg := "memory:\n  provider: everme\n"
	if err := os.WriteFile(filepath.Join(home, "config.yaml"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	d, err := hermesDetector{}.Detect(context.Background())
	if err != nil {
		t.Fatalf("detect: %v", err)
	}
	if !d.HasEverMeEntry {
		t.Fatal("expected HasEverMeEntry=true when provider installed")
	}
}

func TestHermesVerifyChecksProvider(t *testing.T) {
	home := t.TempDir()
	t.Setenv("EVERCLI_HERMES_CONFIG_DIR", home)
	cfgPath := filepath.Join(home, "config.yaml")
	if err := os.WriteFile(cfgPath, []byte("model: x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	w := newHermesWriter()
	plan, _ := w.Plan(context.Background(), cfgPath)
	res, err := w.Commit(context.Background(), plan, WriteParams{
		AgentID: "agt", AgentToken: "evt_x", APIBaseURL: "https://api.everme.evermind.ai",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Verify(context.Background(), res); err != nil {
		t.Fatalf("verify failed after commit: %v", err)
	}
}

func TestHermesDetectProviderFilesButNoConfigKey(t *testing.T) {
	home := t.TempDir()
	t.Setenv("EVERCLI_HERMES_CONFIG_DIR", home)
	// Provider files present, but memory.provider NOT set.
	if err := writeProviderFiles(filepath.Join(home, "plugins")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.yaml"), []byte("model: x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	d, err := hermesDetector{}.Detect(context.Background())
	if err != nil {
		t.Fatalf("detect: %v", err)
	}
	if d.HasEverMeEntry {
		t.Fatal("expected HasEverMeEntry=false when memory.provider missing")
	}
}

func TestHermesDetectConfigKeyButNoProviderFiles(t *testing.T) {
	home := t.TempDir()
	t.Setenv("EVERCLI_HERMES_CONFIG_DIR", home)
	// memory.provider set, but provider package NOT written.
	if err := os.WriteFile(filepath.Join(home, "config.yaml"), []byte("memory:\n  provider: everme\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	d, err := hermesDetector{}.Detect(context.Background())
	if err != nil {
		t.Fatalf("detect: %v", err)
	}
	if d.HasEverMeEntry {
		t.Fatal("expected HasEverMeEntry=false when provider files missing")
	}
}
