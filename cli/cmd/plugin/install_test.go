package plugin

import (
	"bytes"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"evercli/internal/plugin"
)

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
