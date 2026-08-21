package plugin

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/pelletier/go-toml/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// withCodexEnv pins EVERCLI_CODEX_CONFIG_DIR to a tmp dir, plus a fake
// codex CLI binary (defaults to /bin/true so Prepare succeeds). Returns
// the config file path for the test to inspect.
func withCodexEnv(t *testing.T, fakeCodex string) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("EVERCLI_CODEX_CONFIG_DIR", dir)
	t.Setenv("HOME", t.TempDir())
	if fakeCodex == "" {
		fakeCodex = "/bin/true"
	}
	t.Setenv("EVERCLI_CODEX_CMD", fakeCodex)
	// Prepare refuses to install without a Hook interpreter. Pin a stub so the
	// writer tests do not depend on the test machine carrying Node on PATH.
	if runtimeGOOS() != "windows" {
		t.Setenv("EVERCLI_NODE_CMD", writeFakeNode(t, "v22.11.0"))
	}
	return filepath.Join(dir, "config.toml")
}

// writeFakeNode writes a stub that answers `node -v` with the given version
// string, modelling the only Node invocation the install preflight makes.
func writeFakeNode(t *testing.T, version string) string {
	t.Helper()
	stub := filepath.Join(t.TempDir(), "node")
	body := []byte(`#!/bin/sh
case "$1" in
  -v|--version) printf '%s\n' "` + version + `" ;;
  *) exit 0 ;;
esac
`)
	require.NoError(t, os.WriteFile(stub, body, 0o755))
	return stub
}

func readTOML(t *testing.T, path string) map[string]interface{} {
	t.Helper()
	raw, err := os.ReadFile(path)
	require.NoError(t, err)
	var m map[string]interface{}
	require.NoError(t, toml.Unmarshal(raw, &m))
	return m
}

func writeExecutable(t *testing.T, path string, mode os.FileMode) {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), mode))
}

func TestCodexAppBundleCandidates(t *testing.T) {
	t.Parallel()

	assert.Equal(t, []string{
		"/Applications/ChatGPT.app/Contents/Resources/codex",
		"/Applications/Codex.app/Contents/Resources/codex",
		"/Users/test/Applications/ChatGPT.app/Contents/Resources/codex",
		"/Users/test/Applications/Codex.app/Contents/Resources/codex",
	}, codexAppBundleCandidates("/Users/test"))
}

func TestResolveCodexExecutable_OverridePrecedesAppBundle(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	override := filepath.Join(t.TempDir(), "custom-codex")
	writeExecutable(t, override, 0o755)
	t.Setenv("EVERCLI_CODEX_CMD", override)

	appExecutable := filepath.Join(t.TempDir(), "Codex.app", "Contents", "Resources", "codex")
	writeExecutable(t, appExecutable, 0o755)

	got, err := resolveCodexExecutableFromCandidates("darwin", []string{appExecutable})
	require.NoError(t, err)
	assert.Equal(t, override, got)
}

func TestResolveCodexExecutable_PathPrecedesAppBundle(t *testing.T) {
	t.Setenv("EVERCLI_CODEX_CMD", "")
	pathDir := t.TempDir()
	pathExecutable := filepath.Join(pathDir, "codex")
	writeExecutable(t, pathExecutable, 0o755)
	t.Setenv("PATH", pathDir)

	appExecutable := filepath.Join(t.TempDir(), "ChatGPT.app", "Contents", "Resources", "codex")
	writeExecutable(t, appExecutable, 0o755)

	got, err := resolveCodexExecutableFromCandidates("darwin", []string{appExecutable})
	require.NoError(t, err)
	assert.Equal(t, pathExecutable, got)
}

func TestResolveCodexExecutable_AppBundleFallback(t *testing.T) {
	t.Setenv("EVERCLI_CODEX_CMD", "")
	t.Setenv("PATH", t.TempDir())

	nonExecutable := filepath.Join(t.TempDir(), "ChatGPT.app", "Contents", "Resources", "codex")
	writeExecutable(t, nonExecutable, 0o644)
	executable := filepath.Join(t.TempDir(), "Codex.app", "Contents", "Resources", "codex")
	writeExecutable(t, executable, 0o755)

	got, err := resolveCodexExecutableFromCandidates("darwin", []string{nonExecutable, executable})
	require.NoError(t, err)
	assert.Equal(t, executable, got)
}

func TestResolveCodexExecutable_NonDarwinDoesNotUseAppBundle(t *testing.T) {
	t.Setenv("EVERCLI_CODEX_CMD", "")
	t.Setenv("PATH", t.TempDir())

	executable := filepath.Join(t.TempDir(), "Codex.app", "Contents", "Resources", "codex")
	writeExecutable(t, executable, 0o755)

	_, err := resolveCodexExecutableFromCandidates("linux", []string{executable})
	require.Error(t, err)
}

// TestCodexDetector_NoConfig_NotInstalled covers the "Codex not on this
// box" path: the EVERCLI_CODEX_CONFIG_DIR override is a tmp dir that
// exists (so Installed=true via dir presence), but the file inside
// doesn't yet exist.
func TestCodexDetector_NoConfig(t *testing.T) {
	_ = withCodexEnv(t, "")
	d, err := codexDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.Equal(t, PlatformCodex, d.Platform)
	assert.False(t, d.ConfigExists)
	assert.False(t, d.HasEverMeEntry)
}

func TestCodexDetector_WithEverMeEntry(t *testing.T) {
	path := withCodexEnv(t, "")
	body := `[mcp_servers.everme]
command = "npx"
args = ["-y", "@everme/memory-mcp"]

[mcp_servers.everme.env]
EVERME_API_BASE = "https://api.everme.evermind.ai"
EVERME_AGENT_ID = "agt_abc"
EVERME_AGENT_TOKEN = "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
`
	require.NoError(t, os.WriteFile(path, []byte(body), 0o600))

	d, err := codexDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.True(t, d.ConfigExists)
	assert.True(t, d.HasEverMeEntry, "non-empty token must flag entry as present")
}

func TestCodexWriter_RemovePreservesSiblingState(t *testing.T) {
	path := withCodexEnv(t, "")
	body := `[plugins."other@vendor"]
enabled = true

[plugins."everme@everme"]
enabled = true

[marketplaces.everme]
source_type = "git"
source = "https://github.com/EverMind-AI/EverMe.git"

[marketplaces.other]
source_type = "git"
source = "https://example.com/other.git"

[mcp_servers.other]
command = "other"

[mcp_servers.everme]
command = "npx"

[mcp_servers.everme.env]
EVERME_AGENT_TOKEN = "evt_secret"
`
	require.NoError(t, os.WriteFile(path, []byte(body), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(filepath.Dir(path), "everme.env"), []byte("EVERME_AGENT_TOKEN=evt_secret\n"), 0o600))

	res, err := newCodexWriter().Remove(context.Background(), path)
	require.NoError(t, err)
	assert.True(t, res.Removed)
	assert.FileExists(t, res.BackupPath)
	got := readTOML(t, path)
	assert.NotContains(t, got["plugins"].(map[string]interface{}), "everme@everme")
	assert.Contains(t, got["plugins"].(map[string]interface{}), "other@vendor")
	assert.NotContains(t, got["marketplaces"].(map[string]interface{}), "everme")
	assert.Contains(t, got["marketplaces"].(map[string]interface{}), "other")
	assert.NotContains(t, got["mcp_servers"].(map[string]interface{}), "everme")
	assert.Contains(t, got["mcp_servers"].(map[string]interface{}), "other")
	assert.NoFileExists(t, filepath.Join(filepath.Dir(path), "everme.env"))
}

// TestCodexDetector_EntryWithEmptyToken treats an existing-but-empty
// token as "no real entry" — guards against marking a half-installed /
// scrubbed config as good.
func TestCodexDetector_EntryWithEmptyToken(t *testing.T) {
	path := withCodexEnv(t, "")
	body := `[mcp_servers.everme.env]
EVERME_AGENT_TOKEN = ""
`
	require.NoError(t, os.WriteFile(path, []byte(body), 0o600))

	d, err := codexDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.True(t, d.ConfigExists)
	assert.False(t, d.HasEverMeEntry, "empty token must not count as installed")
}

func TestCodexWriter_Commit_FreshFile(t *testing.T) {
	w := newCodexWriter()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")

	plan, err := w.Plan(context.Background(), path)
	require.NoError(t, err)
	assert.True(t, plan.WillCreate)
	assert.False(t, plan.WillReplace)

	res, err := w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_fresh",
		AgentToken: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	})
	require.NoError(t, err)
	require.NotEmpty(t, res.NextSteps)
	// w.trustErr is nil here (Commit was called without Prepare ever
	// running), so under the new logic that means "no manual /hooks step is
	// needed" — see TestCodexWriter_Commit_NextSteps_TrustFailed for the
	// opposite case.
	assert.NotContains(t, strings.Join(res.NextSteps, "\n"), "/hooks")

	envPath := filepath.Join(dir, "everme.env")
	envBody, err := os.ReadFile(envPath)
	require.NoError(t, err)
	assert.Contains(t, string(envBody), "EVERME_API_BASE=https://api.everme.evermind.ai")
	assert.Contains(t, string(envBody), "EVERME_AGENT_ID=agt_fresh")
	assert.Contains(t, string(envBody), "EVERME_AGENT_TOKEN=evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	info, err := os.Stat(envPath)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), info.Mode().Perm())
	assert.NotContains(t, strings.Join(res.NextSteps, "\n"), "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")

	got := readTOML(t, path)

	// [marketplaces.everme] is NOT written by Commit — `codex plugin
	// marketplace add` (Prepare) owns that section. The on-disk smoke
	// confirmed Codex CLI writes its own {source_type, source,
	// last_updated} block. Asserting the absence of our overwrite
	// guards against regressions that re-introduce the conflicting
	// upsert.
	if mp, ok := got["marketplaces"].(map[string]interface{}); ok {
		if _, present := mp["everme"]; present {
			t.Fatalf("Commit must not write [marketplaces.everme] — Codex CLI owns that section via marketplace add")
		}
	}

	plugins, _ := got["plugins"].(map[string]interface{})
	require.NotNil(t, plugins, "[plugins] required")
	spec, _ := plugins["everme@everme"].(map[string]interface{})
	require.NotNil(t, spec, `plugins."everme@everme" required`)
	assert.Equal(t, true, spec["enabled"])

	mcp, _ := got["mcp_servers"].(map[string]interface{})
	require.NotNil(t, mcp)
	entry, _ := mcp["everme"].(map[string]interface{})
	require.NotNil(t, entry)
	// command follows npxCommand() so Windows lands "npx.cmd" instead
	// of bare "npx" (which Codex on Windows can't resolve via PATHEXT).
	wantNpx := "npx"
	if runtimeGOOS() == "windows" {
		wantNpx = "npx.cmd"
	}
	assert.Equal(t, wantNpx, entry["command"], "command must match OS-specific npx variant")
	env, _ := entry["env"].(map[string]interface{})
	require.NotNil(t, env)
	assert.Equal(t, "agt_fresh", env["EVERME_AGENT_ID"])
	assert.Equal(t, "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", env["EVERME_AGENT_TOKEN"])
}

// TestCodexWriter_Commit_NextSteps_TrustFailed asserts the manual "/hooks"
// fallback instruction is restored when Prepare's automatic hook-trust
// attempt failed — the opposite of TestCodexWriter_Commit_FreshFile, which
// covers w.trustErr == nil.
func TestCodexWriter_Commit_NextSteps_TrustFailed(t *testing.T) {
	w := newCodexWriter()
	w.trustErr = errors.New("boom")
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")

	plan, err := w.Plan(context.Background(), path)
	require.NoError(t, err)

	res, err := w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_fresh",
		AgentToken: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	})
	require.NoError(t, err)
	joined := strings.Join(res.NextSteps, "\n")
	assert.Contains(t, joined, "/hooks")
	assert.Contains(t, joined, "trust")
}

// TestCodexWriter_Commit_PreservesUnrelatedKeys is load-bearing: users
// may have custom marketplaces, MCP servers, plugins, [desktop]
// settings, etc. in ~/.codex/config.toml. If install ever clobbers any
// of those, we're going to ruin people's days.
func TestCodexWriter_Commit_PreservesUnrelatedKeys(t *testing.T) {
	w := newCodexWriter()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")

	pre := `# user comment that the round-trip can't preserve

[desktop]
theme = "dark"
font_size = 14

[marketplaces.other]
source_type = "git"
source = "someone/else"

[mcp_servers.other]
command = "noop"

[plugins."other@other"]
enabled = false
`
	require.NoError(t, os.WriteFile(path, []byte(pre), 0o600))

	plan, err := w.Plan(context.Background(), path)
	require.NoError(t, err)
	assert.False(t, plan.WillCreate)
	assert.False(t, plan.WillReplace, "no EverMe entry in pre-existing file")

	_, err = w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_pre",
		AgentToken: "evt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	})
	require.NoError(t, err)

	got := readTOML(t, path)

	desktop, _ := got["desktop"].(map[string]interface{})
	require.NotNil(t, desktop, "[desktop] section must survive")
	assert.Equal(t, "dark", desktop["theme"])
	assert.Equal(t, int64(14), desktop["font_size"])

	mp, _ := got["marketplaces"].(map[string]interface{})
	_, hasOther := mp["other"]
	assert.True(t, hasOther, "user's other marketplace must survive")
	// `marketplaces.everme` is intentionally NOT written by Commit —
	// the `codex plugin marketplace add` CLI in Prepare owns that
	// section. This test fixture skipped Prepare, so the section must
	// be absent here.
	_, hasEverMe := mp["everme"]
	assert.False(t, hasEverMe, "Commit must not add [marketplaces.everme] — Codex CLI owns it via marketplace add")

	mcp, _ := got["mcp_servers"].(map[string]interface{})
	_, hasOtherMCP := mcp["other"]
	assert.True(t, hasOtherMCP, "user's other MCP server must survive")
	_, hasEverMeMCP := mcp["everme"]
	assert.True(t, hasEverMeMCP)

	plugins, _ := got["plugins"].(map[string]interface{})
	otherPlugin, _ := plugins["other@other"].(map[string]interface{})
	require.NotNil(t, otherPlugin, "user's other plugin must survive")
	assert.Equal(t, false, otherPlugin["enabled"])
}

// TestCodexWriter_Commit_RotatesEverMeEntry exercises the same-platform
// re-install path: an existing EverMe section gets overwritten with the
// fresh token, the rest of the file is untouched.
func TestCodexWriter_Commit_RotatesEverMeEntry(t *testing.T) {
	w := newCodexWriter()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")

	pre := `[mcp_servers.everme.env]
EVERME_AGENT_ID = "agt_old"
EVERME_AGENT_TOKEN = "evt_old00000000000000000000000000000000"
`
	require.NoError(t, os.WriteFile(path, []byte(pre), 0o600))

	plan, err := w.Plan(context.Background(), path)
	require.NoError(t, err)
	assert.False(t, plan.WillCreate)
	assert.True(t, plan.WillReplace, "Plan must recognise existing entry")
	assert.NotEmpty(t, plan.BackupPath, ".bak required when overwriting")

	_, err = w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_new",
		AgentToken: "evt_new00000000000000000000000000000000",
	})
	require.NoError(t, err)

	got := readTOML(t, path)
	mcp, _ := got["mcp_servers"].(map[string]interface{})
	entry, _ := mcp["everme"].(map[string]interface{})
	env, _ := entry["env"].(map[string]interface{})
	assert.Equal(t, "agt_new", env["EVERME_AGENT_ID"], "token must rotate")
	assert.Equal(t, "evt_new00000000000000000000000000000000", env["EVERME_AGENT_TOKEN"])

	// Backup exists with old contents.
	bak, err := os.ReadFile(plan.BackupPath)
	require.NoError(t, err)
	assert.Contains(t, string(bak), "evt_old", "backup preserves pre-install token")
}

// TestCodexWriter_Plan_RejectsMalformedTOML guards user data: if the
// existing config is broken TOML, we'd rather fail loudly than silently
// overwrite with a fresh map.
func TestCodexWriter_Plan_RejectsMalformedTOML(t *testing.T) {
	w := newCodexWriter()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	require.NoError(t, os.WriteFile(path, []byte("not valid toml ===="), 0o600))

	_, err := w.Plan(context.Background(), path)
	require.Error(t, err)
}

func TestCodexWriter_Verify_DetectsMissingSection(t *testing.T) {
	w := newCodexWriter()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")

	// Hand-craft a config that's missing the marketplace section.
	body := `[plugins."everme@everme"]
enabled = true

[mcp_servers.everme.env]
EVERME_AGENT_TOKEN = "evt_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"
`
	require.NoError(t, os.WriteFile(path, []byte(body), 0o600))

	err := w.Verify(context.Background(), &WriteResult{ConfigPath: path})
	require.Error(t, err, "Verify must catch missing marketplaces.everme")
}

func TestCodexWriter_Verify_DetectsMissingHooks(t *testing.T) {
	w := newCodexWriter()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	body := `[marketplaces.everme]
source_type = "git"
source = "https://github.com/EverMind-AI/EverMe.git"

[plugins."everme@everme"]
enabled = true

[mcp_servers.everme.env]
EVERME_AGENT_TOKEN = "evt_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"
`
	require.NoError(t, os.WriteFile(path, []byte(body), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "everme.env"), []byte("EVERME_AGENT_TOKEN=evt_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz\n"), 0o600))

	err := w.Verify(context.Background(), &WriteResult{ConfigPath: path})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "hooks")
}

func TestCodexWriter_Verify_AcceptsInstalledHooks(t *testing.T) {
	w := newCodexWriter()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	body := `[marketplaces.everme]
source_type = "git"
source = "https://github.com/EverMind-AI/EverMe.git"

[plugins."everme@everme"]
enabled = true

[mcp_servers.everme.env]
EVERME_AGENT_TOKEN = "evt_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"
`
	require.NoError(t, os.WriteFile(path, []byte(body), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "everme.env"), []byte("EVERME_AGENT_TOKEN=evt_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz\n"), 0o600))
	hooksPath := filepath.Join(dir, "plugins", "cache", "everme", "everme", "0.4.0", "hooks", "hooks.json")
	require.NoError(t, os.MkdirAll(filepath.Dir(hooksPath), 0o700))
	require.NoError(t, os.WriteFile(hooksPath, []byte(`{"hooks":{}}`), 0o600))
	runnerPath := filepath.Join(dir, "plugins", "cache", "everme", "everme", "0.4.0", "bin", "hook.mjs")
	require.NoError(t, os.MkdirAll(filepath.Dir(runnerPath), 0o700))
	require.NoError(t, os.WriteFile(runnerPath, []byte("#!/usr/bin/env node\n"), 0o700))

	require.NoError(t, w.Verify(context.Background(), &WriteResult{ConfigPath: path}))
}

func TestCodexWriter_Verify_DetectsMissingBundledRunner(t *testing.T) {
	w := newCodexWriter()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	body := `[marketplaces.everme]
source_type = "git"
source = "https://github.com/EverMind-AI/EverMe.git"

[plugins."everme@everme"]
enabled = true

[mcp_servers.everme.env]
EVERME_AGENT_TOKEN = "evt_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"
`
	require.NoError(t, os.WriteFile(path, []byte(body), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "everme.env"), []byte("EVERME_AGENT_TOKEN=evt_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz\n"), 0o600))
	hooksPath := filepath.Join(dir, "plugins", "cache", "everme", "everme", "0.4.1", "hooks", "hooks.json")
	require.NoError(t, os.MkdirAll(filepath.Dir(hooksPath), 0o700))
	require.NoError(t, os.WriteFile(hooksPath, []byte(`{"hooks":{}}`), 0o600))

	err := w.Verify(context.Background(), &WriteResult{ConfigPath: path})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "bin/hook.mjs")
}

type fakeCodexOptions struct {
	marketplaceExit int
	upgradeExit     int
	pluginExit      int
	pluginJSON      string
	// appServerHooksJSON, when non-empty, adds an `app-server --stdio`
	// branch to the stub that speaks just enough of the real protocol for
	// codexEstablishHookTrust's fixed, deterministic call sequence: it
	// answers the first non-"initialized" line with an `initialize`-shaped
	// result, and every line after that with a `hooks/list`-shaped result
	// carrying this literal JSON array as the "hooks" list. Left empty
	// (every test but the hook-trust ones), the call falls through to the
	// default `*) exit 2` branch — the process exits without reading
	// stdin, so codexRPCClient sees stdout EOF and the trust attempt fails
	// fast into w.trustErr, leaving every other Prepare behavior unaffected.
	appServerHooksJSON string
}

// writeFakeCodex writes a shell stub that models the four Codex commands
// used by Prepare. Calls are recorded one per line and plugin add emits
// structured JSON so tests exercise the same contract as the real desktop
// binary.
func writeFakeCodex(t *testing.T, options fakeCodexOptions) (stub, callsPath string) {
	t.Helper()
	dir := t.TempDir()
	stub = filepath.Join(dir, "codex")
	callsPath = filepath.Join(dir, "calls.txt")
	pluginJSON := options.pluginJSON
	if pluginJSON == "" {
		installedPath := filepath.Join(t.TempDir(), "plugins", "cache", "everme", "everme", "0.4.1")
		require.NoError(t, os.MkdirAll(filepath.Join(installedPath, "hooks"), 0o700))
		require.NoError(t, os.WriteFile(filepath.Join(installedPath, "hooks", "hooks.json"), []byte(`{"hooks":{}}`), 0o600))
		require.NoError(t, os.MkdirAll(filepath.Join(installedPath, "bin"), 0o700))
		require.NoError(t, os.WriteFile(filepath.Join(installedPath, "bin", "hook.mjs"), []byte("#!/usr/bin/env node\n"), 0o700))
		pluginJSON = `{"pluginId":"everme@everme","installedPath":"` + installedPath + `"}`
	}
	appServerCase := ""
	if options.appServerHooksJSON != "" {
		appServerCase = `  "app-server --stdio")
    i=0
    while IFS= read -r line; do
      case "$line" in
        *'"method":"initialized"'*) continue ;;
      esac
      id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
      i=$((i + 1))
      if [ "$i" -eq 1 ]; then
        printf '{"id":%s,"result":{"userAgent":"fake"}}\n' "$id"
      else
        printf '{"id":%s,"result":{"data":[{"cwd":"","hooks":[` + options.appServerHooksJSON + `]}]}}\n' "$id"
      fi
    done
    ;;
`
	}
	body := []byte(`#!/bin/sh
printf '%s\n' "$*" >> "` + callsPath + `"
case "$*" in
  "plugin marketplace add ` + codexMarketplaceRepo + `") exit ` + strconv.Itoa(options.marketplaceExit) + ` ;;
  "plugin marketplace upgrade ` + codexMarketplaceName + `") exit ` + strconv.Itoa(options.upgradeExit) + ` ;;
  "plugin add ` + codexPluginSpec + ` --json")
    printf '%s\n' '` + pluginJSON + `'
    exit ` + strconv.Itoa(options.pluginExit) + `
    ;;
` + appServerCase + `  *) exit 2 ;;
esac
`)
	require.NoError(t, os.WriteFile(stub, body, 0o755))
	return stub, callsPath
}

// The marketplace Hook manifest runs the bundled runner with a bare `node`, so
// a Node runtime that is not resolvable on PATH leaves every lifecycle Hook
// failing at spawn time. Prepare must reject that machine before the
// marketplace is touched and before the backend mints a token, and must say
// what is missing.
func TestCodexWriter_Prepare_FailsWithoutNodeRuntime(t *testing.T) {
	if runtimeGOOS() == "windows" {
		t.Skip("shell-script stub doesn't execute on Windows; see writeFakeCodex comment")
	}
	stub, callsPath := writeFakeCodex(t, fakeCodexOptions{})
	_ = withCodexEnv(t, stub)
	t.Setenv("EVERCLI_NODE_CMD", "")
	t.Setenv("PATH", t.TempDir())

	err := newCodexWriter().Prepare(context.Background(), &Detection{Platform: PlatformCodex})
	require.Error(t, err)
	assert.Contains(t, strings.ToLower(err.Error()), "node")

	_, statErr := os.Stat(callsPath)
	assert.True(t, os.IsNotExist(statErr), "no codex command may run when the Hook runtime is missing")
}

// A Node older than the runner's build target parses the bundle but can fail on
// syntax or APIs it does not implement, so the preflight pins the floor too.
func TestCodexWriter_Prepare_FailsWhenNodeRuntimeTooOld(t *testing.T) {
	if runtimeGOOS() == "windows" {
		t.Skip("shell-script stub doesn't execute on Windows; see writeFakeCodex comment")
	}
	stub, callsPath := writeFakeCodex(t, fakeCodexOptions{})
	_ = withCodexEnv(t, stub)
	t.Setenv("EVERCLI_NODE_CMD", writeFakeNode(t, "v16.20.2"))

	err := newCodexWriter().Prepare(context.Background(), &Detection{Platform: PlatformCodex})
	require.Error(t, err)
	assert.Contains(t, err.Error(), strconv.Itoa(codexHookNodeMinMajor))

	_, statErr := os.Stat(callsPath)
	assert.True(t, os.IsNotExist(statErr), "no codex command may run when the Hook runtime is too old")
}

func TestResolveNodeExecutable_OverridePrecedesPath(t *testing.T) {
	pathDir := t.TempDir()
	writeExecutable(t, filepath.Join(pathDir, "node"), 0o755)
	t.Setenv("PATH", pathDir)
	override := writeFakeNode(t, "v22.11.0")
	t.Setenv("EVERCLI_NODE_CMD", override)

	resolved, err := resolveNodeExecutable()
	require.NoError(t, err)
	assert.Equal(t, override, resolved)
}

func TestResolveNodeExecutable_FallsBackToPath(t *testing.T) {
	pathDir := t.TempDir()
	onPath := filepath.Join(pathDir, "node")
	writeExecutable(t, onPath, 0o755)
	t.Setenv("PATH", pathDir)
	t.Setenv("EVERCLI_NODE_CMD", "")

	resolved, err := resolveNodeExecutable()
	require.NoError(t, err)
	assert.Equal(t, onPath, resolved)
}

// TestCodexWriter_Prepare_HappyPath stubs the codex CLI with a script
// that exits 0, so the marketplace-add path completes without needing
// a real Codex install on the test box. The stub also captures argv
// so a regression in the constants (marketplace repo) or a re-added
// --sparse flag would fail this test loudly.
func TestCodexWriter_Prepare_HappyPath(t *testing.T) {
	if runtimeGOOS() == "windows" {
		t.Skip("shell-script stub doesn't execute on Windows; see writeFakeCodex comment")
	}
	stub, callsPath := writeFakeCodex(t, fakeCodexOptions{})
	_ = withCodexEnv(t, stub)
	w := newCodexWriter()
	err := w.Prepare(context.Background(), &Detection{Platform: PlatformCodex})
	require.NoError(t, err)

	// Pin the exact argv the production Prepare passes to `codex`. A
	// regression renaming codexMarketplaceRepo, re-adding --sparse, or
	// reordering args trips this test.
	got, err := os.ReadFile(callsPath)
	require.NoError(t, err, "stub must have written argv")
	assert.Equal(t,
		"plugin marketplace add "+codexMarketplaceRepo+"\nplugin add "+codexPluginSpec+" --json\napp-server --stdio\n",
		string(got),
		"Prepare must register the marketplace, install the plugin, and then attempt hook trust")
}

// TestCodexWriter_Prepare_UpgradesWhenMarketplaceAlreadyAdded pins the
// stale-cache refresh: if `[marketplaces.everme]` is already in
// config.toml (Codex CLI wrote it on a previous install), Prepare must
// run `codex plugin marketplace upgrade everme` instead of `add`.
// Without the upgrade, a machine that registered the marketplace once
// keeps its plugin cache at that first version forever, so content
// shipped later (e.g. lifecycle hooks) never reaches it and
// verify-hooks warns about a missing hooks.json.
func TestCodexWriter_Prepare_UpgradesWhenMarketplaceAlreadyAdded(t *testing.T) {
	if runtimeGOOS() == "windows" {
		t.Skip("shell-script stub doesn't execute on Windows; see writeFakeCodex comment")
	}
	stub, callsPath := writeFakeCodex(t, fakeCodexOptions{})
	configPath := withCodexEnv(t, stub)

	body := `[marketplaces.everme]
last_updated = "2026-05-26T10:32:09Z"
source_type = "local"
source = "/some/cached/path"

[mcp_servers.everme.env]
EVERME_AGENT_TOKEN = "evt_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"
`
	require.NoError(t, os.WriteFile(configPath, []byte(body), 0o600))

	w := newCodexWriter()
	detection, err := codexDetector{}.Detect(context.Background())
	require.NoError(t, err)
	require.NotEmpty(t, detection.ConfigPath, "Detector must surface the config path Prepare reads")

	require.NoError(t, w.Prepare(context.Background(), detection))

	raw, err := os.ReadFile(callsPath)
	require.NoError(t, err, "Prepare must invoke the codex CLI to refresh the marketplace cache")
	assert.Equal(t,
		"plugin marketplace upgrade everme\nplugin add "+codexPluginSpec+" --json\napp-server --stdio\n",
		string(raw),
		"already-registered path must upgrade, reinstall the everme plugin, and attempt hook trust")
}

// TestCodexWriter_Prepare_EstablishesHookTrust is the real-subprocess
// integration test proving the spawnCodexAppServer -> OS pipes ->
// codexRPCClient -> codexEstablishHookTrustWithClient wiring works
// end-to-end against an actual child process (not just the interface-level
// fakes in codex_hook_trust_test.go). It only needs to cover the
// already-trusted happy path — the branchy needs-trust / missing-hooks /
// reverify-failure logic is already fully pinned by those fake-client tests.
func TestCodexWriter_Prepare_EstablishesHookTrust(t *testing.T) {
	if runtimeGOOS() == "windows" {
		t.Skip("shell-script stub doesn't execute on Windows; see writeFakeCodex comment")
	}
	allTrustedHooks := `` +
		`{"key":"everme@everme:hooks/hooks.json:session_start:0:0","eventName":"sessionStart","pluginId":"everme@everme","currentHash":"sha256:a","trustStatus":"trusted"},` +
		`{"key":"everme@everme:hooks/hooks.json:user_prompt_submit:0:0","eventName":"userPromptSubmit","pluginId":"everme@everme","currentHash":"sha256:b","trustStatus":"trusted"},` +
		`{"key":"everme@everme:hooks/hooks.json:stop:0:0","eventName":"stop","pluginId":"everme@everme","currentHash":"sha256:c","trustStatus":"trusted"},` +
		`{"key":"everme@everme:hooks/hooks.json:pre_compact:0:0","eventName":"preCompact","pluginId":"everme@everme","currentHash":"sha256:d","trustStatus":"trusted"}`
	stub, _ := writeFakeCodex(t, fakeCodexOptions{appServerHooksJSON: allTrustedHooks})
	_ = withCodexEnv(t, stub)

	w := newCodexWriter()
	err := w.Prepare(context.Background(), &Detection{Platform: PlatformCodex})
	require.NoError(t, err)
	assert.NoError(t, w.trustErr, "already-trusted hooks must round-trip through the real app-server RPC wiring without error")
}

// TestCodexWriter_Prepare_UpgradeFailureDoesNotBlockInstall pins the
// offline-rotate contract that the old skip path provided: the upgrade
// is best-effort. A box without network (or with a broken codex CLI)
// must still be able to rotate its token — Prepare returns nil and the
// failure is deferred to Verify, where it surfaces as an install
// warning instead of a FailedEntry.
func TestCodexWriter_Prepare_UpgradeFailureDoesNotBlockInstall(t *testing.T) {
	if runtimeGOOS() == "windows" {
		t.Skip("shell-script stub doesn't execute on Windows; see writeFakeCodex comment")
	}
	stub, _ := writeFakeCodex(t, fakeCodexOptions{upgradeExit: 1})
	configPath := withCodexEnv(t, stub)

	body := `[marketplaces.everme]
source_type = "git"
source = "https://github.com/EverMind-AI/EverMe.git"

[plugins."everme@everme"]
enabled = true

[mcp_servers.everme.env]
EVERME_AGENT_TOKEN = "evt_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"
`
	require.NoError(t, os.WriteFile(configPath, []byte(body), 0o600))

	w := newCodexWriter()
	detection, err := codexDetector{}.Detect(context.Background())
	require.NoError(t, err)

	require.NoError(t, w.Prepare(context.Background(), detection),
		"a failed marketplace upgrade must not block token rotation")

	// Build the rest of a healthy install so Verify's own checks pass
	// and the only remaining signal is the deferred upgrade failure.
	dir := filepath.Dir(configPath)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "everme.env"), []byte("EVERME_AGENT_TOKEN=evt_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz\n"), 0o600))
	hooksPath := filepath.Join(dir, "plugins", "cache", "everme", "everme", "0.4.0", "hooks", "hooks.json")
	require.NoError(t, os.MkdirAll(filepath.Dir(hooksPath), 0o700))
	require.NoError(t, os.WriteFile(hooksPath, []byte(`{"hooks":{}}`), 0o600))
	runnerPath := filepath.Join(dir, "plugins", "cache", "everme", "everme", "0.4.0", "bin", "hook.mjs")
	require.NoError(t, os.MkdirAll(filepath.Dir(runnerPath), 0o700))
	require.NoError(t, os.WriteFile(runnerPath, []byte("#!/usr/bin/env node\n"), 0o700))

	err = w.Verify(context.Background(), &WriteResult{ConfigPath: configPath})
	require.Error(t, err, "Verify must surface the deferred upgrade failure as a warning")
	assert.Contains(t, err.Error(), "upgrade", "warning must point at the marketplace upgrade step")
}

func TestCodexWriter_Prepare_ReusesHealthyCacheWhenPluginRefreshFails(t *testing.T) {
	if runtimeGOOS() == "windows" {
		t.Skip("shell-script stub doesn't execute on Windows; see writeFakeCodex comment")
	}
	stub, _ := writeFakeCodex(t, fakeCodexOptions{upgradeExit: 1, pluginExit: 1})
	configPath := withCodexEnv(t, stub)
	body := `[marketplaces.everme]
source_type = "git"
source = "https://github.com/EverMind-AI/EverMe.git"
`
	require.NoError(t, os.WriteFile(configPath, []byte(body), 0o600))
	installedPath := filepath.Join(filepath.Dir(configPath), "plugins", "cache", "everme", "everme", "0.4.1")
	require.NoError(t, os.MkdirAll(filepath.Join(installedPath, "hooks"), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(installedPath, "hooks", "hooks.json"), []byte(`{"hooks":{}}`), 0o600))
	require.NoError(t, os.MkdirAll(filepath.Join(installedPath, "bin"), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(installedPath, "bin", "hook.mjs"), []byte("#!/usr/bin/env node\n"), 0o700))

	w := newCodexWriter()
	require.NoError(t, w.Prepare(context.Background(), &Detection{Platform: PlatformCodex, ConfigPath: configPath}))
	assert.Equal(t, installedPath, w.installedPath)
	require.Error(t, w.pluginInstallErr)
}

func TestInstallCodexPlugin_RejectsMalformedJSON(t *testing.T) {
	if runtimeGOOS() == "windows" {
		t.Skip("shell-script stub doesn't execute on Windows; see writeFakeCodex comment")
	}
	stub, _ := writeFakeCodex(t, fakeCodexOptions{pluginJSON: "not-json"})

	_, err := installCodexPlugin(context.Background(), stub)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "parse-json")
}

func TestInstallCodexPlugin_RejectsMissingInstalledPath(t *testing.T) {
	if runtimeGOOS() == "windows" {
		t.Skip("shell-script stub doesn't execute on Windows; see writeFakeCodex comment")
	}
	stub, _ := writeFakeCodex(t, fakeCodexOptions{pluginJSON: `{}`})

	_, err := installCodexPlugin(context.Background(), stub)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "installedPath")
}

// TestMarketplaceAlreadyAdded covers the helper's branches directly,
// so future maintainers see every shape it tolerates without inferring
// from the Prepare-skip integration test. Specifically guards:
//   - nil detection -> false (defensive; would otherwise NPE on .ConfigPath)
//   - empty ConfigPath -> false (Detector that lost the path mid-flight)
//   - missing file -> false (Detector said Installed but file disappeared)
//   - empty config file -> false (no [marketplaces] table yet)
//   - other marketplaces present but not `everme` -> false (user has their own)
//   - [marketplaces.everme] present -> true (the skip-CLI signal)
//   - malformed TOML -> false (parser surfaces the error in Plan later,
//     so Prepare must not skip on bad data — re-running CLI is the safer
//     default)
func TestMarketplaceAlreadyAdded(t *testing.T) {
	t.Run("nil detection", func(t *testing.T) {
		assert.False(t, marketplaceAlreadyAdded(nil))
	})

	t.Run("empty ConfigPath", func(t *testing.T) {
		assert.False(t, marketplaceAlreadyAdded(&Detection{Platform: PlatformCodex}))
	})

	t.Run("config file missing", func(t *testing.T) {
		dir := t.TempDir()
		assert.False(t, marketplaceAlreadyAdded(&Detection{ConfigPath: filepath.Join(dir, "config.toml")}))
	})

	t.Run("empty config file", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "config.toml")
		require.NoError(t, os.WriteFile(path, []byte(""), 0o600))
		assert.False(t, marketplaceAlreadyAdded(&Detection{ConfigPath: path}))
	})

	t.Run("other marketplace but not everme", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "config.toml")
		body := `[marketplaces.openai-bundled]
source_type = "local"
source = "/some/path"
`
		require.NoError(t, os.WriteFile(path, []byte(body), 0o600))
		assert.False(t, marketplaceAlreadyAdded(&Detection{ConfigPath: path}),
			"presence of a different marketplace must not flip the everme check")
	})

	t.Run("marketplaces.everme present", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "config.toml")
		body := `[marketplaces.everme]
source_type = "git"
source = "EverMind-AI/EverMe"
last_updated = "2026-05-26T10:32:09Z"
`
		require.NoError(t, os.WriteFile(path, []byte(body), 0o600))
		assert.True(t, marketplaceAlreadyAdded(&Detection{ConfigPath: path}),
			"this is THE signal that lets Prepare skip the CLI shellout — drift breaks offline rotate")
	})

	t.Run("malformed TOML", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "config.toml")
		require.NoError(t, os.WriteFile(path, []byte("not valid toml ==="), 0o600))
		// Returning false here means Prepare will attempt the CLI add;
		// the user's malformed config gets surfaced by Plan in the
		// next step, with a clearer error than "marketplace already
		// added (probably)".
		assert.False(t, marketplaceAlreadyAdded(&Detection{ConfigPath: path}),
			"malformed TOML must not be mistaken for `marketplace already added` — fail loud later")
	})
}

func TestCodexWriter_Prepare_FailsClosed(t *testing.T) {
	if runtimeGOOS() == "windows" {
		t.Skip("shell-script stub doesn't execute on Windows; see writeFakeCodex comment")
	}
	stub, _ := writeFakeCodex(t, fakeCodexOptions{marketplaceExit: 1})
	_ = withCodexEnv(t, stub)
	w := newCodexWriter()
	err := w.Prepare(context.Background(), &Detection{Platform: PlatformCodex})
	require.Error(t, err, "Prepare must surface the non-zero exit to prevent token mint")
}

// TestCodexWriter_ImplementsLifecycleInterfaces is a static guard: if
// future refactors remove Preparer/Verifier from codexWriter, the
// install pipeline would silently skip them (no compile error, just a
// regression where marketplace add stops running before /agents). Pin
// the contract with type assertions.
func TestCodexWriter_ImplementsLifecycleInterfaces(t *testing.T) {
	w := newCodexWriter()
	_, isPreparer := any(w).(Preparer)
	assert.True(t, isPreparer, "codexWriter must implement Preparer — marketplace add runs before /agents")
	_, isVerifier := any(w).(Verifier)
	assert.True(t, isVerifier, "codexWriter must implement Verifier — post-Commit re-parse")
}
