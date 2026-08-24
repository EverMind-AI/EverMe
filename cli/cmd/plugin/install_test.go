package plugin

import (
	"bytes"
	"io"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"evercli/internal/output"
	"evercli/internal/plugin"
)

func TestCompleteInstallWritesEnvelope(t *testing.T) {
	var stdout bytes.Buffer
	out := output.NewWriterTo(&stdout, io.Discard, output.FormatJSON)
	require.NoError(t, completeInstall(out, &plugin.InstallReport{}))
	assert.Contains(t, stdout.String(), `"ok": true`)
}

// TestRenderInstall_WarningsSurfaceInText pins the post-fix behavior:
// when Verify trips a warning, the text renderer MUST print it so a
// human running `evercli plugin install codex` doesn't only see the
// green ✓ + "Restart" line. The JSON envelope already carries
// .data.installed[].warnings; this guards against the text renderer
// silently swallowing the same field.
func TestRenderInstall_WarningsSurfaceInText(t *testing.T) {
	rep := &plugin.InstallReport{
		Installed: []plugin.InstallEntry{
			{
				Platform:    "codex",
				AgentID:     "agt_xyz",
				TokenPrefix: "evt_1234",
				ConfigPath:  "/home/u/.codex/config.toml",
				Warnings:    []string{"mcp_servers.everme missing on read-back"},
			},
		},
	}

	var buf bytes.Buffer
	require.NoError(t, renderInstall(&buf, rep))

	out := buf.String()
	assert.Contains(t, out, "✓ codex", "happy-path line must still render")
	assert.Contains(t, out, "⚠ warning: mcp_servers.everme missing on read-back",
		"warning text must appear inline under the entry that triggered it — otherwise humans see green ✓ only")
	assert.Contains(t, out, "evercli doctor",
		"footer must point users at doctor when any entry has warnings")
}

// TestRenderInstall_NextStepsSurfaceInText pins that a per-entry NextSteps
// (e.g. Kimi Code's manual TUI `/plugins install` registration) is printed
// under the ✓ line so a human doesn't stop at the green check and miss the
// required follow-up. Distinct from Warnings: a next-step is not a sanity-
// check failure and must NOT trigger the doctor hint.
func TestRenderInstall_NextStepsSurfaceInText(t *testing.T) {
	rep := &plugin.InstallReport{
		Installed: []plugin.InstallEntry{
			{
				Platform:    "kimicode",
				AgentID:     "agt_kc",
				TokenPrefix: "evt_kc",
				ConfigPath:  "/home/u/.kimi-code/everme.env",
				NextSteps:   []string{"in the Kimi Code TUI, run `/plugins install /home/u/.kimi-code/everme` to register (no headless install)"},
			},
		},
	}

	var buf bytes.Buffer
	require.NoError(t, renderInstall(&buf, rep))

	out := buf.String()
	assert.Contains(t, out, "✓ kimicode", "happy-path line must still render")
	assert.Contains(t, out, "/plugins install /home/u/.kimi-code/everme",
		"the next-step instruction must appear under the entry")
	assert.False(t, strings.Contains(out, "evercli doctor"),
		"a next-step is not a warning; it must not trigger the doctor hint")
}

// TestRenderInstall_NoWarningsOmitsDoctorHint avoids spamming the
// doctor-recommendation when every install succeeded cleanly. The
// "Restart" line is still expected, but the doctor line is only for
// the warnings path.
func TestRenderInstall_NoWarningsOmitsDoctorHint(t *testing.T) {
	rep := &plugin.InstallReport{
		Installed: []plugin.InstallEntry{
			{Platform: "cursor", AgentID: "agt_a", TokenPrefix: "evt_a", ConfigPath: "/c/mcp.json"},
		},
	}

	var buf bytes.Buffer
	require.NoError(t, renderInstall(&buf, rep))
	out := buf.String()
	assert.Contains(t, out, "Restart the affected Agent")
	assert.False(t, strings.Contains(out, "evercli doctor"),
		"no warnings → no doctor hint; otherwise every clean install spams the recommendation")
}
