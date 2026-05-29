package plugin

import (
	"context"
	"os"
	"path/filepath"
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
	return filepath.Join(dir, "config.toml")
}

func readTOML(t *testing.T, path string) map[string]interface{} {
	t.Helper()
	raw, err := os.ReadFile(path)
	require.NoError(t, err)
	var m map[string]interface{}
	require.NoError(t, toml.Unmarshal(raw, &m))
	return m
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

	_, err = w.Commit(context.Background(), plan, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_fresh",
		AgentToken: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	})
	require.NoError(t, err)

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

// writeFakeCodex writes a tiny shell script that exits `code` and
// returns (stub path, argv sentinel path). The stub records its argv
// to the sentinel file before exiting so the test can assert Prepare
// invoked the CLI with the right flags — a regression renaming
// EverMind-AI/EverMe or re-adding a --sparse flag would otherwise pass
// with any stub that ignores argv.
//
// On Windows this script can't execute (CreateProcess won't honour the
// shebang and there's no .cmd shim) — the Codex Prepare tests skip on
// non-Unix platforms via runtimeGOOS. See test bodies for the guard.
func writeFakeCodex(t *testing.T, code int) (stub, argvPath string) {
	t.Helper()
	dir := t.TempDir()
	stub = filepath.Join(dir, "codex")
	argvPath = filepath.Join(dir, "argv.txt")
	exitStr := "0"
	if code != 0 {
		exitStr = "1"
	}
	body := []byte(`#!/bin/sh
# evercli test stub — records argv and exits with the configured code
for arg in "$@"; do
  printf '%s\n' "$arg" >> "` + argvPath + `"
done
exit ` + exitStr + "\n")
	require.NoError(t, os.WriteFile(stub, body, 0o755))
	return stub, argvPath
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
	stub, argvPath := writeFakeCodex(t, 0)
	_ = withCodexEnv(t, stub)
	w := newCodexWriter()
	err := w.Prepare(context.Background(), &Detection{Platform: PlatformCodex})
	require.NoError(t, err)

	// Pin the exact argv the production Prepare passes to `codex`. A
	// regression renaming codexMarketplaceRepo, re-adding --sparse, or
	// reordering args trips this test.
	got, err := os.ReadFile(argvPath)
	require.NoError(t, err, "stub must have written argv")
	gotArgs := strings.Split(strings.TrimSpace(string(got)), "\n")
	want := []string{
		"plugin", "marketplace", "add",
		codexMarketplaceRepo,
	}
	assert.Equal(t, want, gotArgs, "Prepare must call `codex plugin marketplace add <repo>` with the canonical repo constant (no --sparse: the repo root is the marketplace)")
}

// TestCodexWriter_Prepare_SkipsCLIWhenMarketplaceAlreadyAdded pins
// the offline-rotate optimization: if `[marketplaces.everme]` is
// already in config.toml (Codex CLI wrote it on a previous install),
// Prepare must NOT shell out to `codex` again. This lets a token
// rotate work fully offline once the marketplace has been registered,
// and avoids re-fetching the GitHub repo on every rotate.
//
// The stub is wired to exit 1 — if it gets called at all, Prepare
// fails and the test reports it. Argv sentinel is also checked: the
// file must remain absent (no writes happened) for the skip path to
// be truly skipped, not just "called with no args".
func TestCodexWriter_Prepare_SkipsCLIWhenMarketplaceAlreadyAdded(t *testing.T) {
	if runtimeGOOS() == "windows" {
		t.Skip("shell-script stub doesn't execute on Windows; see writeFakeCodex comment")
	}
	// Stub fails if invoked — proves the skip is real.
	stub, argvPath := writeFakeCodex(t, 1)
	configPath := withCodexEnv(t, stub)

	// Pre-seed the config with `[marketplaces.everme]` (and matching
	// MCP entry so HasEverMeEntry would also be true). Both signals
	// should route Prepare into the skip branch.
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

	err = w.Prepare(context.Background(), detection)
	require.NoError(t, err, "Prepare must skip the CLI shellout when marketplace is already registered — token rotation should not require network")

	// Argv sentinel must be absent: the fake codex stub creates it on
	// invocation. Skip path = no invocation = no sentinel.
	_, statErr := os.Stat(argvPath)
	assert.True(t, os.IsNotExist(statErr),
		"fake codex stub recorded argv at %s — Prepare invoked the CLI when it should have skipped", argvPath)
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
	stub, _ := writeFakeCodex(t, 1)
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
