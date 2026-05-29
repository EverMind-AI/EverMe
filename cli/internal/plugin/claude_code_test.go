package plugin

import (
	"context"
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
	_, err := buildEnvFileBody(WriteParams{
		APIBaseURL: "https://api.everme.evermind.ai",
		AgentID:    "agt_abc",
		AgentToken: "evt_value\ninjected=true",
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "control")
}

func TestBuildEnvFileBody_HappyPath(t *testing.T) {
	body, err := buildEnvFileBody(WriteParams{
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

func TestPluginSourceSpec_PriorityChain(t *testing.T) {
	// Order documented in pluginSourceSpec:
	//   1. struct-injected pluginSource (test-only)
	//   2. EVERCLI_CLAUDE_PLUGIN_SOURCE env override
	//   3. globalNpmPluginPath() — probe `npm root -g`/@everme/claude-code
	//   4. ensureNpmPluginInstalled() — run `npm install -g @everme/claude-code`, then retry probe
	//
	// Layers 3 and 4 require a working `npm` and are exercised by the
	// end-to-end install verification (plan §`端到端验证`). The unit tests
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
