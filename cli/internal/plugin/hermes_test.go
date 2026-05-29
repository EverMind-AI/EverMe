package plugin

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"
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

// TestHermesDetector_ConfigWithEverMe_ReportsEntry proves
// HasEverMeEntry reads the canonical `mcp_servers.everme` YAML path
// AND requires env.EVERME_AGENT_TOKEN to be non-empty — same contract
// codex.go enforces (codexHasEverMeEntry). Sibling `mcp_servers.other`
// must be ignored.
func TestHermesDetector_ConfigWithEverMe_ReportsEntry(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("EVERCLI_HERMES_CONFIG_DIR", dir)
	t.Setenv("HOME", t.TempDir())
	t.Setenv("EVERCLI_HERMES_CMD", "/nonexistent/hermes")

	path := filepath.Join(dir, "config.yaml")
	body := `agent:
  max_turns: 90
mcp_servers:
  everme:
    command: npx
    args:
    - -y
    - "@everme/memory-mcp"
    env:
      EVERME_API_BASE: https://api.everme.evermind.ai
      EVERME_AGENT_ID: agt_test
      EVERME_AGENT_TOKEN: evt_test_token_aaaaaaaaaaaaaaaaaa
  other:
    command: noop
`
	require.NoError(t, os.WriteFile(path, []byte(body), 0o600))

	d, err := hermesDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.True(t, d.ConfigExists)
	assert.True(t, d.HasEverMeEntry, "must recognise existing mcp_servers.everme entry with a token")
}

// TestHermesDetector_StubEntry_NoToken_NotReported is the P2 regression
// guard: a hand-written / stale Hermes entry that lacks
// env.EVERME_AGENT_TOKEN (e.g. a half-baked README paste, or a stale
// scaffold left after the user disconnected the agent on the backend)
// must NOT be reported as configured. Otherwise `plugin list` /
// Verify show "installed" for an entry that can't actually authenticate.
// Mirrors codex's contract (codexHasEverMeEntry requires
// env.EVERME_AGENT_TOKEN != "").
func TestHermesDetector_StubEntry_NoToken_NotReported(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("EVERCLI_HERMES_CONFIG_DIR", dir)
	t.Setenv("HOME", t.TempDir())
	t.Setenv("EVERCLI_HERMES_CMD", "/nonexistent/hermes")

	path := filepath.Join(dir, "config.yaml")
	stub := `mcp_servers:
  everme:
    command: npx
    args:
    - -y
    - "@everme/memory-mcp"
    env:
      EVERME_API_BASE: https://api.everme.evermind.ai
`
	require.NoError(t, os.WriteFile(path, []byte(stub), 0o600))

	d, err := hermesDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.True(t, d.ConfigExists)
	assert.False(t, d.HasEverMeEntry, "entry without EVERME_AGENT_TOKEN must not be reported as configured")
}

// TestHermesDetector_EmptyTokenString_NotReported is the adjacent
// regression: an entry with EVERME_AGENT_TOKEN: "" (explicit empty
// string) must also be treated as "not configured". Catches the
// failure mode where a tool / hand-edit zeroed the token without
// removing the env block.
func TestHermesDetector_EmptyTokenString_NotReported(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("EVERCLI_HERMES_CONFIG_DIR", dir)
	t.Setenv("HOME", t.TempDir())
	t.Setenv("EVERCLI_HERMES_CMD", "/nonexistent/hermes")

	path := filepath.Join(dir, "config.yaml")
	body := `mcp_servers:
  everme:
    command: npx
    env:
      EVERME_AGENT_TOKEN: ""
`
	require.NoError(t, os.WriteFile(path, []byte(body), 0o600))

	d, err := hermesDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.False(t, d.HasEverMeEntry, "empty-string token must not be reported as configured")
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

// TestHermesWriter_FreshFile creates a config.yaml from scratch and
// pins the on-disk entry shape — keys (command/args/env), nested
// env values including the freshly minted token. Also exercises
// Verify on the result.
func TestHermesWriter_FreshFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")

	w := newHermesWriter()
	plan, err := w.Plan(context.Background(), path)
	require.NoError(t, err)
	assert.True(t, plan.WillCreate)
	assert.False(t, plan.WillReplace)
	assert.Empty(t, plan.BackupPath, "fresh file has no prior state to back up")

	res, err := w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_hermes_test",
		AgentToken: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	})
	require.NoError(t, err)
	require.NotNil(t, res)
	assert.True(t, res.WroteNewEntry)
	assert.Empty(t, res.BackupPath)

	cfg := readHermesYAMLFile(t, path)
	servers, ok := cfg["mcp_servers"].(map[string]interface{})
	require.True(t, ok, "top-level mcp_servers must be a map")
	entry, ok := servers["everme"].(map[string]interface{})
	require.True(t, ok, "mcp_servers.everme must be a map")
	assert.Equal(t, "npx", entry["command"])

	env, _ := entry["env"].(map[string]interface{})
	require.NotNil(t, env)
	assert.Equal(t, "https://api.everme.evermind.ai", env["EVERME_API_BASE"])
	assert.Equal(t, "agt_hermes_test", env["EVERME_AGENT_ID"])
	assert.Equal(t, "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", env["EVERME_AGENT_TOKEN"])

	// Verify round-trip sanity check passes.
	require.NoError(t, (&hermesWriter{}).Verify(context.Background(), res))
}

// TestHermesWriter_PreservesSiblingKeys is the load-bearing test:
// upsert must preserve every other key in config.yaml (agent.*,
// memory.*, _config_version, other mcp_servers.* entries) verbatim.
// yaml.v3 unmarshal-to-map throws away comments (acceptable, V1
// trade-off documented in hermes.go) but must NEVER lose data.
func TestHermesWriter_PreservesSiblingKeys(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	initial := `_config_version: 12
agent:
  max_turns: 90
  verbose: false
memory:
  provider: everos
  everos:
    base_url: http://localhost:1995
mcp_servers:
  n8n:
    command: python
    args:
    - /opt/n8n/server.py
    env:
      N8N_KEY: secret
`
	require.NoError(t, os.WriteFile(path, []byte(initial), 0o600))

	w := newHermesWriter()
	plan, err := w.Plan(context.Background(), path)
	require.NoError(t, err)
	assert.False(t, plan.WillCreate)
	assert.False(t, plan.WillReplace, "no everme entry yet → not replace")
	assert.NotEmpty(t, plan.BackupPath, "existing file must have a backup target")

	_, err = w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_hermes",
		AgentToken: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	})
	require.NoError(t, err)

	cfg := readHermesYAMLFile(t, path)
	// Sibling top-level scalar preserved.
	assert.Equal(t, 12, cfg["_config_version"])

	agent, ok := cfg["agent"].(map[string]interface{})
	require.True(t, ok)
	assert.Equal(t, 90, agent["max_turns"])
	assert.Equal(t, false, agent["verbose"])

	memory, ok := cfg["memory"].(map[string]interface{})
	require.True(t, ok)
	assert.Equal(t, "everos", memory["provider"])
	everos, ok := memory["everos"].(map[string]interface{})
	require.True(t, ok)
	assert.Equal(t, "http://localhost:1995", everos["base_url"])

	// Sibling mcp_servers entry preserved + new everme entry added.
	servers, ok := cfg["mcp_servers"].(map[string]interface{})
	require.True(t, ok)
	n8n, ok := servers["n8n"].(map[string]interface{})
	require.True(t, ok, "n8n sibling must survive the upsert")
	assert.Equal(t, "python", n8n["command"])
	n8nEnv, _ := n8n["env"].(map[string]interface{})
	assert.Equal(t, "secret", n8nEnv["N8N_KEY"])

	everme, ok := servers["everme"].(map[string]interface{})
	require.True(t, ok)
	evermeEnv, _ := everme["env"].(map[string]interface{})
	assert.Equal(t, "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", evermeEnv["EVERME_AGENT_TOKEN"])

	// Backup must exist and contain the original (untouched) bytes.
	backupRaw, err := os.ReadFile(plan.BackupPath)
	require.NoError(t, err)
	assert.Equal(t, initial, string(backupRaw), "backup must be byte-for-byte original")
}

// TestHermesWriter_ReinstallReplaces — re-running install upserts the
// entry idempotently with a fresh token. Plan reports WillReplace=true
// and Result.WroteNewEntry=false so JSON callers can distinguish
// "first install" from "rotate".
func TestHermesWriter_ReinstallReplaces(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	initial := `mcp_servers:
  everme:
    command: npx
    args:
    - -y
    - "@everme/memory-mcp"
    env:
      EVERME_API_BASE: https://api.everme.evermind.ai
      EVERME_AGENT_ID: agt_old
      EVERME_AGENT_TOKEN: evt_old_token
`
	require.NoError(t, os.WriteFile(path, []byte(initial), 0o600))

	w := newHermesWriter()
	plan, err := w.Plan(context.Background(), path)
	require.NoError(t, err)
	assert.True(t, plan.WillReplace, "existing everme entry should be detected")
	assert.NotEmpty(t, plan.BackupPath)

	res, err := w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_new",
		AgentToken: "evt_new_token_aaaaaaaaaaaaaaaaaaaa",
	})
	require.NoError(t, err)
	assert.False(t, res.WroteNewEntry, "reinstall is a replace, not a new entry")

	cfg := readHermesYAMLFile(t, path)
	servers, _ := cfg["mcp_servers"].(map[string]interface{})
	entry, _ := servers["everme"].(map[string]interface{})
	env, _ := entry["env"].(map[string]interface{})
	assert.Equal(t, "agt_new", env["EVERME_AGENT_ID"], "agent id must be replaced")
	assert.Equal(t, "evt_new_token_aaaaaaaaaaaaaaaaaaaa", env["EVERME_AGENT_TOKEN"], "token must be replaced")
}

// TestHermesWriter_RejectsMcpServersAsList — refuses to silently
// overwrite when mcp_servers exists with a non-map type (e.g. user
// typoed it as a YAML sequence). The user gets a structured error
// pointing at the shape collision rather than losing their data.
func TestHermesWriter_RejectsMcpServersAsList(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	require.NoError(t, os.WriteFile(path, []byte("mcp_servers:\n  - mistyped-as-a-list\n"), 0o600))

	w := newHermesWriter()
	plan, err := w.Plan(context.Background(), path)
	require.NoError(t, err)

	_, err = w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_test",
		AgentToken: "evt_test",
	})
	require.Error(t, err, "must refuse rather than overwrite user's mcp_servers list")
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

// readHermesYAMLFile is a test helper: parses a YAML file into a
// generic map for assertions on the round-tripped shape.
func readHermesYAMLFile(t *testing.T, path string) map[string]interface{} {
	t.Helper()
	raw, err := os.ReadFile(path)
	require.NoError(t, err)
	var cfg map[string]interface{}
	require.NoError(t, yaml.Unmarshal(raw, &cfg))
	return cfg
}
