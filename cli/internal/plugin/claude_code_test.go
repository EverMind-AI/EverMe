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

// TestClaudeListContains_FormatTolerance pins down what we DO and what
// we DON'T parse out of `claude plugin list` / `claude mcp list`. The
// helper greps by name; this test catches future false-positive risk
// before it ships. If you have to change these expectations because CC
// shipped a new format, also update the FRAGILITY NOTE on
// claudeListContains.
func TestClaudeListContains_FormatTolerance(t *testing.T) {
	cases := []struct {
		name string
		out  string
		want bool
	}{
		// Historical "plain list" format (pre table-rendering).
		{"plain list with our name", "everme\nother-plugin\n", true},

		// Current table format from `claude plugin list`.
		{"table with our name", "│ everme         │ 0.2.0  │\n│ other-plugin   │ 1.0.0  │\n", true},

		// `claude mcp list` health-check format.
		{"mcp list with our row", "Checking MCP server health…\neverme: stdio - ✓ healthy\nrovo: https - ! needs auth\n", true},

		// JSON-prefixed (some CC versions in --verbose mode).
		{"json-ish output", `{"plugins":[{"name":"everme","version":"0.2.0"}]}`, true},

		// Sad paths — exactly what we want false-positive-free.
		{"empty output", "", false},
		{"only unrelated plugins", "other-plugin\nrovo\nasana-mcp\n", false},
		{"superstring (our name embedded in another)", "evermex-other\n", true /* false-positive — acknowledged in helper comment */},
	}
	for _, c := range cases {
		got := claudeListContains([]byte(c.out), evermePluginName)
		assert.Equal(t, c.want, got, c.name)
	}
}

func TestPluginSourceAllowed_Whitelist(t *testing.T) {
	cases := map[string]bool{
		"https://github.com/example/repo.git":                 true,
		"/Users/me/.npm/lib/node_modules/@everme/claude-code": true,
		"http://insecure":                  false,
		"git+ssh://git@github.com/x/y.git": false,
		"file:///Users/me":                 false,
		"":                                 false,
		"./relative":                       false,
		"https://example.com/x;rm -rf":     false, // contains a space, rejected by the whitespace gate
		`"quoted"`:                         false,
	}
	for in, ok := range cases {
		err := pluginSourceAllowed(in)
		if ok {
			assert.NoError(t, err, "%q must be accepted", in)
		} else {
			assert.Error(t, err, "%q must be rejected", in)
		}
	}
}

func TestBuildEnvFileBody_RejectsControlChars(t *testing.T) {
	// agentToken with embedded \n breaks downstream `set -a; .` loaders
	// and KEY=value parsers — refuse the write rather than escape and
	// hope.
	_, err := buildEnvFileBody(PlatformClaudeCode, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_abc",
		AgentToken: "evt_value\ninjected=true",
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "control")
}

func TestBuildEnvFileBody_HappyPath(t *testing.T) {
	body, err := buildEnvFileBody(PlatformClaudeCode, WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_abc",
		AgentToken: "evt_xyz",
	})
	require.NoError(t, err)
	for _, want := range []string{"EVERME_API_BASE=https://api.everme.evermind.ai", "EVERME_AGENT_ID=agt_abc", "EVERME_AGENT_TOKEN=evt_xyz"} {
		assert.Contains(t, body, want)
	}
	assert.True(t, strings.HasPrefix(body, "# Managed by evercli"))
}

// writeClaudeStub drops an executable shell script that records every
// invocation's argv (one line per call) into logPath and exits 0. Used
// as the EVERCLI_CLAUDE_CMD seam so Remove tests can assert which
// `claude ...` commands ran without a real Claude Code install.
func writeClaudeStub(t *testing.T, logPath string) string {
	t.Helper()
	stub := filepath.Join(t.TempDir(), "claude")
	script := "#!/bin/sh\necho \"$@\" >> " + logPath + "\nexit 0\n"
	require.NoError(t, os.WriteFile(stub, []byte(script), 0o755))
	return stub
}

// writeClaudeStubFailing behaves like writeClaudeStub but exits 1 for
// every invocation whose argv starts with failPrefix. Used to exercise
// the install/update fallback without a real Claude Code.
func writeClaudeStubFailing(t *testing.T, logPath, failPrefix string) string {
	t.Helper()
	stub := filepath.Join(t.TempDir(), "claude")
	script := "#!/bin/sh\n" +
		"echo \"$@\" >> " + logPath + "\n" +
		"case \"$*\" in \"" + failPrefix + "\"*) exit 1;; esac\n" +
		"exit 0\n"
	require.NoError(t, os.WriteFile(stub, []byte(script), 0o755))
	return stub
}

// seedClaudePluginState writes the two read-only files under
// $HOME/.claude/plugins that evercli consults to pick a verb and to
// assert the cache moved. An empty body skips that file.
func seedClaudePluginState(t *testing.T, home, knownMarketplaces, installedPlugins string) {
	t.Helper()
	dir := filepath.Join(home, ".claude", "plugins")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	if knownMarketplaces != "" {
		require.NoError(t, os.WriteFile(filepath.Join(dir, claudeKnownMarketplacesFile), []byte(knownMarketplaces), 0o600))
	}
	if installedPlugins != "" {
		require.NoError(t, os.WriteFile(filepath.Join(dir, claudeInstalledPluginsFile), []byte(installedPlugins), 0o600))
	}
}

// writeClaudePayload writes a minimal @everme/claude-code payload
// declaring the given versions in its marketplace entry and plugin
// manifest. An empty version omits that field.
func writeClaudePayload(t *testing.T, marketplaceVersion, manifestVersion string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "payload")
	require.NoError(t, os.MkdirAll(filepath.Join(dir, ".claude-plugin"), 0o755))
	entry := `{"name":"everme","source":"./"`
	if marketplaceVersion != "" {
		entry += `,"version":"` + marketplaceVersion + `"`
	}
	entry += `}`
	marketplace := `{"name":"everme","plugins":[` + entry + `]}`
	require.NoError(t, os.WriteFile(filepath.Join(dir, ".claude-plugin", "marketplace.json"), []byte(marketplace), 0o644))
	manifest := `{"name":"everme"`
	if manifestVersion != "" {
		manifest += `,"version":"` + manifestVersion + `"`
	}
	manifest += `}`
	require.NoError(t, os.WriteFile(filepath.Join(dir, ".claude-plugin", "plugin.json"), []byte(manifest), 0o644))
	return dir
}

// installedPluginsJSON renders an installed_plugins.json (schema 2)
// carrying one user-scope entry for everme@everme at version v.
func installedPluginsJSON(v string) string {
	return `{"version":2,"plugins":{"everme@everme":[{"scope":"user","installPath":"/cache/everme/everme/` + v + `","version":"` + v + `"}]}}`
}

// TestClaudeCachedPluginVersion pins how we read Claude Code's own
// install state: the user-scope entry wins, an absent file or a foreign
// entry means "nothing cached", and a malformed file is an error rather
// than a silent "not installed" (which would pick the install verb and
// hide a broken host).
func TestClaudeCachedPluginVersion(t *testing.T) {
	t.Run("userScopeEntry", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		seedClaudePluginState(t, home, "", installedPluginsJSON("0.4.2"))
		got, err := claudeCachedPluginVersion()
		require.NoError(t, err)
		assert.Equal(t, "0.4.2", got)
	})

	t.Run("missingFileIsNotAnError", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		got, err := claudeCachedPluginVersion()
		require.NoError(t, err)
		assert.Equal(t, "", got)
	})

	t.Run("otherPluginsOnly", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		seedClaudePluginState(t, home, "", `{"version":2,"plugins":{"superpowers@official":[{"scope":"user","version":"6.2.0"}]}}`)
		got, err := claudeCachedPluginVersion()
		require.NoError(t, err)
		assert.Equal(t, "", got)
	})

	t.Run("malformedIsErrored", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		seedClaudePluginState(t, home, "", "{not json")
		_, err := claudeCachedPluginVersion()
		require.Error(t, err)
	})
}

func TestClaudeSourceManifestVersion(t *testing.T) {
	t.Run("marketplaceEntryWins", func(t *testing.T) {
		// The marketplace entry is the version Claude Code names its cache
		// directory after, so it must beat plugin.json when they disagree.
		got, err := claudeSourceManifestVersion(writeClaudePayload(t, "0.5.0", "0.4.2"))
		require.NoError(t, err)
		assert.Equal(t, "0.5.0", got)
	})

	t.Run("pluginManifestFallback", func(t *testing.T) {
		got, err := claudeSourceManifestVersion(writeClaudePayload(t, "", "0.4.2"))
		require.NoError(t, err)
		assert.Equal(t, "0.4.2", got)
	})

	t.Run("httpsSourceIsNotComparable", func(t *testing.T) {
		got, err := claudeSourceManifestVersion("https://github.com/example/repo.git")
		require.NoError(t, err)
		assert.Equal(t, "", got, "a remote source can't be read without a fetch; skip instead of guessing")
	})

	t.Run("missingPayloadIsNotComparable", func(t *testing.T) {
		got, err := claudeSourceManifestVersion(filepath.Join(t.TempDir(), "absent"))
		require.NoError(t, err)
		assert.Equal(t, "", got)
	})
}

// TestClaudeCodeWriter_SyncMarketplace pins the refresh verb. `add` on an
// already-registered identical source only prints "already on disk" and
// re-reads nothing, so a registered marketplace must go through `update`.
func TestClaudeCodeWriter_SyncMarketplace(t *testing.T) {
	source := filepath.Join(t.TempDir(), "payload")

	t.Run("unregisteredIsAdded", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		callLog := filepath.Join(t.TempDir(), "calls.log")
		t.Setenv("EVERCLI_CLAUDE_CMD", writeClaudeStub(t, callLog))

		require.NoError(t, newClaudeCodeWriter().syncMarketplace(context.Background(), source))
		calls, err := os.ReadFile(callLog)
		require.NoError(t, err)
		assert.Contains(t, string(calls), "plugin marketplace add "+source)
		assert.NotContains(t, string(calls), "marketplace update")
	})

	t.Run("registeredIsUpdated", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		seedClaudePluginState(t, home,
			`{"everme":{"source":{"source":"directory","path":"`+source+`"},"installLocation":"`+source+`"}}`, "")
		callLog := filepath.Join(t.TempDir(), "calls.log")
		t.Setenv("EVERCLI_CLAUDE_CMD", writeClaudeStub(t, callLog))

		require.NoError(t, newClaudeCodeWriter().syncMarketplace(context.Background(), source))
		calls, err := os.ReadFile(callLog)
		require.NoError(t, err)
		assert.Contains(t, string(calls), "plugin marketplace update everme")
		assert.NotContains(t, string(calls), "marketplace add", "add is not a refresh — it prints \"already on disk\"")
	})

	t.Run("movedDirectorySourceIsReAdded", func(t *testing.T) {
		// npm's global prefix changed: the recorded path is stale, and
		// `add` is what repoints the entry.
		home := t.TempDir()
		t.Setenv("HOME", home)
		seedClaudePluginState(t, home,
			`{"everme":{"source":{"source":"directory","path":"/old/prefix/@everme/claude-code"}}}`, "")
		callLog := filepath.Join(t.TempDir(), "calls.log")
		t.Setenv("EVERCLI_CLAUDE_CMD", writeClaudeStub(t, callLog))

		require.NoError(t, newClaudeCodeWriter().syncMarketplace(context.Background(), source))
		calls, err := os.ReadFile(callLog)
		require.NoError(t, err)
		assert.Contains(t, string(calls), "plugin marketplace add "+source)
	})

	t.Run("failedUpdateFallsBackToAdd", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		seedClaudePluginState(t, home,
			`{"everme":{"source":{"source":"directory","path":"`+source+`"}}}`, "")
		callLog := filepath.Join(t.TempDir(), "calls.log")
		t.Setenv("EVERCLI_CLAUDE_CMD", writeClaudeStubFailing(t, callLog, "plugin marketplace update"))

		require.NoError(t, newClaudeCodeWriter().syncMarketplace(context.Background(), source))
		calls, err := os.ReadFile(callLog)
		require.NoError(t, err)
		assert.Contains(t, string(calls), "plugin marketplace update everme")
		assert.Contains(t, string(calls), "plugin marketplace add "+source, "a broken entry is repaired by re-adding")
	})
}

// TestClaudeCodeWriter_InstallOrUpdatePlugin is the core of the fix: a
// cached plugin must be refreshed with `plugin update`, because `plugin
// install` exits 0 with "already installed" and keeps the old cache.
func TestClaudeCodeWriter_InstallOrUpdatePlugin(t *testing.T) {
	t.Run("freshInstallUsesInstall", func(t *testing.T) {
		callLog := filepath.Join(t.TempDir(), "calls.log")
		t.Setenv("EVERCLI_CLAUDE_CMD", writeClaudeStub(t, callLog))

		require.NoError(t, newClaudeCodeWriter().installOrUpdatePlugin(context.Background(), false))
		calls, err := os.ReadFile(callLog)
		require.NoError(t, err)
		assert.Equal(t, "plugin install everme@everme\n", string(calls))
	})

	t.Run("cachedPluginUsesUpdate", func(t *testing.T) {
		callLog := filepath.Join(t.TempDir(), "calls.log")
		t.Setenv("EVERCLI_CLAUDE_CMD", writeClaudeStub(t, callLog))

		require.NoError(t, newClaudeCodeWriter().installOrUpdatePlugin(context.Background(), true))
		calls, err := os.ReadFile(callLog)
		require.NoError(t, err)
		assert.Equal(t, "plugin update everme@everme\n", string(calls),
			"the qualified spec is mandatory: `claude plugin update everme` fails with \"Plugin not found\"")
	})

	t.Run("failedUpdateFallsBackToInstall", func(t *testing.T) {
		// installed_plugins.json said "cached" but Claude Code disagrees
		// (hand-deleted cache directory) — the fallback must still land a
		// working install.
		callLog := filepath.Join(t.TempDir(), "calls.log")
		t.Setenv("EVERCLI_CLAUDE_CMD", writeClaudeStubFailing(t, callLog, "plugin update"))

		require.NoError(t, newClaudeCodeWriter().installOrUpdatePlugin(context.Background(), true))
		calls, err := os.ReadFile(callLog)
		require.NoError(t, err)
		assert.Contains(t, string(calls), "plugin update everme@everme")
		assert.Contains(t, string(calls), "plugin install everme@everme")
	})

	t.Run("bothVerbsFailingIsErrored", func(t *testing.T) {
		stub := filepath.Join(t.TempDir(), "claude")
		require.NoError(t, os.WriteFile(stub, []byte("#!/bin/sh\nexit 1\n"), 0o755))
		t.Setenv("EVERCLI_CLAUDE_CMD", stub)

		require.Error(t, newClaudeCodeWriter().installOrUpdatePlugin(context.Background(), true))
	})
}

// TestClaudeCodeWriter_Verify_VersionDrift is the "force a version check"
// half of the fix: every shell-out can exit 0 while Claude Code still
// serves an older cache, so the version comparison is the only proof the
// user runs what we shipped.
func TestClaudeCodeWriter_Verify_VersionDrift(t *testing.T) {
	newEnvFile := func(t *testing.T, home string) string {
		t.Helper()
		claudeDir := filepath.Join(home, ".claude")
		require.NoError(t, os.MkdirAll(claudeDir, 0o700))
		envPath := filepath.Join(claudeDir, "everme.env")
		require.NoError(t, os.WriteFile(envPath, []byte("# managed\nEVERME_AGENT_TOKEN=evt_x\n"), 0o600))
		return envPath
	}

	t.Run("staleCacheIsReported", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		envPath := newEnvFile(t, home)
		seedClaudePluginState(t, home, "", installedPluginsJSON("0.4.2"))

		w := newClaudeCodeWriter()
		w.resolvedSource = writeClaudePayload(t, "0.5.0", "0.5.0")
		err := w.Verify(context.Background(), &WriteResult{ConfigPath: envPath})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "0.4.2")
		assert.Contains(t, err.Error(), "0.5.0")
	})

	t.Run("matchingVersionPasses", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		envPath := newEnvFile(t, home)
		seedClaudePluginState(t, home, "", installedPluginsJSON("0.5.0"))

		w := newClaudeCodeWriter()
		w.resolvedSource = writeClaudePayload(t, "0.5.0", "0.5.0")
		require.NoError(t, w.Verify(context.Background(), &WriteResult{ConfigPath: envPath}))
	})

	t.Run("nothingCachedAfterInstallIsReported", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		envPath := newEnvFile(t, home)

		w := newClaudeCodeWriter()
		w.resolvedSource = writeClaudePayload(t, "0.5.0", "0.5.0")
		err := w.Verify(context.Background(), &WriteResult{ConfigPath: envPath})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "no cached everme plugin")
	})

	t.Run("unreadableSourceSkipsTheAssertion", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		envPath := newEnvFile(t, home)
		seedClaudePluginState(t, home, "", installedPluginsJSON("0.4.2"))

		w := newClaudeCodeWriter()
		w.resolvedSource = "https://github.com/example/repo.git"
		require.NoError(t, w.Verify(context.Background(), &WriteResult{ConfigPath: envPath}),
			"a source we can't read must not be asserted against")
	})

	t.Run("missingTokenIsReported", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		claudeDir := filepath.Join(home, ".claude")
		require.NoError(t, os.MkdirAll(claudeDir, 0o700))
		envPath := filepath.Join(claudeDir, "everme.env")
		require.NoError(t, os.WriteFile(envPath, []byte("# managed\nEVERME_AGENT_ID=agt_x\n"), 0o600))

		err := newClaudeCodeWriter().Verify(context.Background(), &WriteResult{ConfigPath: envPath})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "agent token")
	})
}

// TestClaudeCodeWriter_Remove_EnvFileIsNotJSON pins the HIGH bug: the
// detector's ConfigPath is ~/.claude/everme.env — a KEY=value file with
// '#' comments. Routing it through the JSON mcpWriter.Remove used to
// fail every `plugin uninstall claude-code` with a parse-json error.
// Remove must succeed, delete the env file, and run the best-effort
// host deregistration commands.
func TestClaudeCodeWriter_Remove_EnvFileIsNotJSON(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	claudeDir := filepath.Join(home, ".claude")
	require.NoError(t, os.MkdirAll(claudeDir, 0o700))
	envPath := filepath.Join(claudeDir, "everme.env")
	body, err := buildEnvFileBody(PlatformClaudeCode, WriteParams{
		APIBaseURL: "https://api.test",
		AgentID:    "agt_x",
		AgentToken: "evt_x",
	})
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(body, "#"), "fixture must exercise the '#' comment header")
	require.NoError(t, os.WriteFile(envPath, []byte(body), 0o600))

	callLog := filepath.Join(t.TempDir(), "calls.log")
	t.Setenv("EVERCLI_CLAUDE_CMD", writeClaudeStub(t, callLog))

	res, err := newClaudeCodeWriter().Remove(context.Background(), envPath)
	require.NoError(t, err, "the KEY=value env file must never be JSON-parsed")
	assert.True(t, res.Removed)
	assert.Equal(t, envPath, res.ConfigPath)
	_, statErr := os.Stat(envPath)
	assert.True(t, os.IsNotExist(statErr), "env file must be deleted")

	calls, readErr := os.ReadFile(callLog)
	require.NoError(t, readErr, "the claude stub must have been invoked")
	assert.Contains(t, string(calls), "plugin uninstall everme")
	assert.Contains(t, string(calls), "plugin marketplace remove everme")
}

// TestClaudeCodeWriter_Remove_HostCommandFailureIsNonFatal pins the
// best-effort contract: a failing `claude` CLI (already-uninstalled
// plugin, broken install) warns but never blocks the env-file cleanup.
func TestClaudeCodeWriter_Remove_HostCommandFailureIsNonFatal(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	claudeDir := filepath.Join(home, ".claude")
	require.NoError(t, os.MkdirAll(claudeDir, 0o700))
	envPath := filepath.Join(claudeDir, "everme.env")
	require.NoError(t, os.WriteFile(envPath, []byte("# managed\nEVERME_AGENT_TOKEN=evt_x\n"), 0o600))

	stub := filepath.Join(t.TempDir(), "claude")
	require.NoError(t, os.WriteFile(stub, []byte("#!/bin/sh\nexit 1\n"), 0o755))
	t.Setenv("EVERCLI_CLAUDE_CMD", stub)

	res, err := newClaudeCodeWriter().Remove(context.Background(), envPath)
	require.NoError(t, err)
	assert.True(t, res.Removed)
	_, statErr := os.Stat(envPath)
	assert.True(t, os.IsNotExist(statErr))
}

// TestClaudeCodeWriter_Remove_EmptyConfigPath guards the
// filepath.Abs("") → cwd trap: an empty detector ConfigPath must
// resolve to the canonical ~/.claude/everme.env, never the working
// directory. Missing env file is an idempotent no-op.
func TestClaudeCodeWriter_Remove_EmptyConfigPath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	// Point the claude seam at a non-existent binary so LookPath fails
	// and the best-effort shell-outs are skipped entirely.
	t.Setenv("EVERCLI_CLAUDE_CMD", filepath.Join(t.TempDir(), "no-such-claude"))

	res, err := newClaudeCodeWriter().Remove(context.Background(), "")
	require.NoError(t, err)
	assert.False(t, res.Removed, "missing env file is a successful no-op")
	assert.Equal(t, filepath.Join(home, ".claude", "everme.env"), res.ConfigPath)
	wd, wdErr := os.Getwd()
	require.NoError(t, wdErr)
	assert.NotEqual(t, wd, res.ConfigPath, "empty configPath must never resolve to the cwd")
}

func TestPluginSourceSpec_PriorityChain(t *testing.T) {
	// Order documented in pluginSourceSpec:
	//   1. struct-injected pluginSource (test-only)
	//   2. EVERCLI_CLAUDE_PLUGIN_SOURCE env override
	//   3. globalNpmPluginPath() — probe `npm root -g`/@everme/claude-code
	//   4. ensureNpmPluginInstalled() — run `npm install -g @everme/claude-code`, then retry probe
	//
	// Layers 3 and 4 require a working `npm` and are exercised by the
	// end-to-end install verification (plan, end-to-end section). The unit tests
	// below cover layers 1 and 2 plus the npm-missing error path —
	// enough to catch regressions in the priority chain without bringing
	// up a real npm registry in CI.

	// (1) Struct injection wins over env.
	t.Run("structInjectionBeatsEnv", func(t *testing.T) {
		t.Setenv("EVERCLI_CLAUDE_PLUGIN_SOURCE", "https://env.example.com/x.git")
		w := &claudeCodeWriter{pluginSource: "/abs/from/struct"}
		got, resolved, err := w.pluginSourceSpec(context.Background(), false)
		require.NoError(t, err)
		assert.Equal(t, "/abs/from/struct", got)
		assert.True(t, resolved)
	})

	// (2) Env override wins over the npm probe.
	t.Run("envBeatsNpmProbe", func(t *testing.T) {
		t.Setenv("EVERCLI_CLAUDE_PLUGIN_SOURCE", "https://forked.example.com/x.git")
		w := &claudeCodeWriter{}
		got, resolved, err := w.pluginSourceSpec(context.Background(), false)
		require.NoError(t, err)
		assert.Equal(t, "https://forked.example.com/x.git", got)
		assert.True(t, resolved)
	})

	// (3) With env unset and no `npm` on PATH and installIfMissing=true,
	// we surface a clear npm-missing error rather than silently
	// returning a dead URL.
	t.Run("missingNpmIsErrored", func(t *testing.T) {
		t.Setenv("EVERCLI_CLAUDE_PLUGIN_SOURCE", "")
		t.Setenv("PATH", "")
		w := &claudeCodeWriter{}
		_, _, err := w.pluginSourceSpec(context.Background(), true)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "npm")
	})

	// (4) Plan path (installIfMissing=false) with no env / no npm
	// available returns ("", false, nil) — the caller surfaces a
	// "would install" preview rather than aborting Plan.
	t.Run("planSkipsInstallAndReturnsUnresolved", func(t *testing.T) {
		t.Setenv("EVERCLI_CLAUDE_PLUGIN_SOURCE", "")
		t.Setenv("PATH", "")
		w := &claudeCodeWriter{}
		got, resolved, err := w.pluginSourceSpec(context.Background(), false)
		require.NoError(t, err)
		assert.Equal(t, "", got)
		assert.False(t, resolved)
	})
}
