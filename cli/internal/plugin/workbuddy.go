package plugin

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"

	"evercli/internal/output"
)

type workBuddyDetector struct{}

func (workBuddyDetector) Platform() Platform { return PlatformWorkBuddy }

func (workBuddyDetector) DisplayName() string { return "WorkBuddy" }

func (workBuddyDetector) Detect(_ context.Context) (*Detection, error) {
	dir, err := workBuddyConfigDir()
	if err != nil {
		return &Detection{Platform: PlatformWorkBuddy, DisplayName: "WorkBuddy"}, nil
	}
	detection := &Detection{
		Platform:    PlatformWorkBuddy,
		DisplayName: "WorkBuddy",
		ConfigPath:  workBuddyConfigPathInDir(dir),
		Installed:   workBuddyInstalled(dir),
	}

	config, exists, err := readConfig(detection.ConfigPath)
	if err != nil {
		return detection, err
	}
	detection.ConfigExists = exists
	if exists {
		detection.HasEverMeEntry = nestedMcpServersHasEntry(config, claudeCodeServersPath, mcpEntryName)
	}
	return detection, nil
}

func workBuddyConfigPath() (string, error) {
	dir, err := workBuddyConfigDir()
	if err != nil {
		return "", err
	}
	return workBuddyConfigPathInDir(dir), nil
}

// workBuddyConfigPathInDir returns the canonical WorkBuddy MCP config.
// This is the only file WorkBuddy reads user MCP servers from; do not
// probe alternatives — `.mcp.json` is WorkBuddy's generated
// connector-proxy aggregate and `connectors/default/mcp.json` is the
// app-shipped connector marketplace, both app-owned.
func workBuddyConfigPathInDir(dir string) string {
	return filepath.Join(dir, "mcp.json")
}

func workBuddyConfigDir() (string, error) {
	if dir := os.Getenv("EVERCLI_WORKBUDDY_CONFIG_DIR"); dir != "" {
		return dir, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", output.IOErr("workbuddy", "resolve-home", err)
	}
	return filepath.Join(home, ".workbuddy"), nil
}

func workBuddyInstalled(configDir string) bool {
	if _, err := os.Stat(configDir); err == nil {
		return true
	}
	if appPath := os.Getenv("EVERCLI_WORKBUDDY_APP_PATH"); appPath != "" {
		if _, err := os.Stat(appPath); err == nil {
			return true
		}
		// Stale override: fall through to the PATH / darwin probes
		// instead of declaring WorkBuddy absent outright.
	}
	if _, err := exec.LookPath("workbuddy"); err == nil {
		return true
	}
	if runtimeGOOS() == "darwin" {
		for _, path := range []string{"/Applications/WorkBuddy.app", filepath.Join(os.Getenv("HOME"), "Applications", "WorkBuddy.app")} {
			if _, err := os.Stat(path); err == nil {
				return true
			}
		}
	}
	return false
}

// workBuddyWriter wraps the shared mcpWriter to surface the manual
// trust step: WorkBuddy keeps a newly added MCP server disabled (shown
// as failed) until the user trusts it in the MCP management dialog, so
// a successful config write alone does not make the plugin usable.
type workBuddyWriter struct {
	*mcpWriter
}

func newWorkBuddyWriter() Writer {
	return workBuddyWriter{newMCPWriter(PlatformWorkBuddy)}
}

func (w workBuddyWriter) Commit(ctx context.Context, plan *WritePlan, params WriteParams) (*WriteResult, error) {
	res, err := w.mcpWriter.Commit(ctx, plan, params)
	if res != nil {
		res.NextSteps = append(res.NextSteps,
			"open WorkBuddy's MCP management dialog and trust the everme-memory server — it stays disabled until the first-connection trust prompt is confirmed")
	}
	return res, err
}
