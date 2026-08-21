package plugin

import (
	"bytes"
	"errors"
	"testing"

	"github.com/spf13/cobra"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"evercli/internal/cmdctx"
	"evercli/internal/output"
	"evercli/internal/plugin"
)

// newUninstallRoot builds a minimal root that carries the persistent
// global flags (--no-prompt et al.) exactly like the production root,
// so Snapshot() sees what cobra parsed.
func newUninstallRoot() *cobra.Command {
	root := &cobra.Command{Use: "evercli"}
	cmdctx.RegisterGlobalFlags(root)
	root.AddCommand(newUninstall())
	return root
}

// TestUninstall_NoPromptWithoutYes_ExitsValidation pins the guard: in
// --no-prompt mode the destructive uninstall requires --yes and must
// fail with the invalid_args exit code (2) before touching anything.
func TestUninstall_NoPromptWithoutYes_ExitsValidation(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())

	root := newUninstallRoot()
	var out, errOut bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&errOut)
	root.SetArgs([]string{"uninstall", "cursor", "--no-prompt"})

	err := root.Execute()
	require.Error(t, err, "--no-prompt without --yes must be a hard failure")
	var ee *output.ExitError
	require.True(t, errors.As(err, &ee), "failure must carry the canonical exit code")
	assert.Equal(t, output.ExitValidation, ee.Code, "invalid_args maps to exit code 2")
	assert.Equal(t, 2, int(ee.Code))
}

// ---- text renderer --------------------------------------------------

// TestRenderUninstall_DisconnectErrorSurfacesWarning pins the most
// important text-mode fact: when the cloud disconnect failed, the token
// is still live and the human must be told to revoke it in the web UI.
func TestRenderUninstall_DisconnectErrorSurfacesWarning(t *testing.T) {
	res := &plugin.UninstallResult{
		Platform:   "claude-code",
		Removed:    true,
		ConfigPath: "/home/u/.claude/everme.env",
		DisconnectError: &plugin.DisconnectErrorDetail{
			Type:    output.TypeAuth,
			Code:    30001,
			Message: "ErrUnauthorized",
			AgentID: "agt_x",
		},
	}

	var buf bytes.Buffer
	require.NoError(t, renderUninstall(&buf, res))
	got := buf.String()
	assert.Contains(t, got, "✓ claude-code", "local removal line must render")
	assert.Contains(t, got, "STILL LIVE",
		"a failed disconnect means the token still works — the warning must be unmissable")
	assert.Contains(t, got, "web UI", "user needs the manual revoke pointer")
	assert.Contains(t, got, "ErrUnauthorized")
}

// TestRenderUninstall_NextStepsAndDetectErrorSurface covers the
// remaining channels: kimicode's mandatory TUI step only travels via
// NextSteps, and a LocalDetectError must not vanish in text mode.
func TestRenderUninstall_NextStepsAndDetectErrorSurface(t *testing.T) {
	res := &plugin.UninstallResult{
		Platform: "kimicode",
		Removed:  true,
		LocalDetectError: &plugin.DetectErrorItem{
			Type:    string(output.TypeIO),
			Message: "config unreadable",
		},
		NextSteps: []string{"in the Kimi Code TUI, run `/plugins remove everme` to unregister"},
	}

	var buf bytes.Buffer
	require.NoError(t, renderUninstall(&buf, res))
	got := buf.String()
	assert.Contains(t, got, "/plugins remove everme",
		"the mandatory TUI step travels only via NextSteps")
	assert.Contains(t, got, "config unreadable", "detect error must surface")
}

// TestRenderUninstall_CleanAndDisconnected is the happy path: local
// state removed and the cloud agent disconnected, no warnings.
func TestRenderUninstall_CleanAndDisconnected(t *testing.T) {
	res := &plugin.UninstallResult{
		Platform:          "cursor",
		Removed:           true,
		AgentDisconnected: true,
		ConfigPath:        "/home/u/.cursor/mcp.json",
		BackupPath:        "/home/u/.cursor/mcp.json-bak",
	}

	var buf bytes.Buffer
	require.NoError(t, renderUninstall(&buf, res))
	got := buf.String()
	assert.Contains(t, got, "✓ cursor")
	assert.Contains(t, got, "backup=/home/u/.cursor/mcp.json-bak")
	assert.Contains(t, got, "cloud agent disconnected")
	assert.NotContains(t, got, "WARNING")
}

// TestRenderUninstall_NoLocalEntryStillRendersNoMatch covers the
// already-clean local state combined with the no-fingerprint-match
// outcome: both facts must be visible.
func TestRenderUninstall_NoLocalEntryStillRendersNoMatch(t *testing.T) {
	res := &plugin.UninstallResult{
		Platform:             "devin",
		Removed:              false,
		NoMatchingCloudAgent: true,
		NextSteps: []string{
			"no cloud agent matched this machine's fingerprint for devin, so none was disconnected — if an agent for this machine still appears in the EverMe web UI, disconnect it there",
		},
	}

	var buf bytes.Buffer
	require.NoError(t, renderUninstall(&buf, res))
	got := buf.String()
	assert.Contains(t, got, "no local EverMe entry found")
	assert.Contains(t, got, "no cloud agent matched this machine's fingerprint")
}
