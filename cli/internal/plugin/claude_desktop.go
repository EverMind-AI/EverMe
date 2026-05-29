// Package plugin — Claude Desktop support.
//
// Claude Desktop loads MCP servers from a JSON file with the same shape
// as Claude Code (top-level `mcpServers.<name>`), so the writer reuses
// `mcpWriter` with the canonical `mcpServers` path. What's different is
// the OS-specific config-file location:
//
//	macOS   ~/Library/Application Support/Claude/claude_desktop_config.json
//	Windows %APPDATA%\Claude\claude_desktop_config.json
//	Linux   ~/.config/claude-desktop/claude_desktop_config.json
//
// The Linux path follows the XDG-style layout Anthropic ships in their
// experimental Linux build; it is documented but not the most common
// deployment target. macOS / Windows are the V1 must-pass cells.
//
// EVERCLI_CLAUDE_DESKTOP_CONFIG_DIR lets tests pin the parent dir.
package plugin

import (
	"context"
	"os"
	"path/filepath"

	"evercli/internal/output"
)

const claudeDesktopConfigFile = "claude_desktop_config.json"

type claudeDesktopDetector struct{}

func (claudeDesktopDetector) Platform() Platform { return PlatformClaudeDesktop }

func (claudeDesktopDetector) DisplayName() string { return "Claude Desktop" }

func (claudeDesktopDetector) Detect(_ context.Context) (*Detection, error) {
	path, err := claudeDesktopConfigPath()
	if err != nil {
		return &Detection{Platform: PlatformClaudeDesktop, DisplayName: "Claude Desktop"}, nil
	}
	d := &Detection{
		Platform:    PlatformClaudeDesktop,
		DisplayName: "Claude Desktop",
		ConfigPath:  path,
	}

	// "Installed" = the Claude Desktop config dir exists. Claude Desktop
	// is a GUI app with no canonical CLI on $PATH, so the config dir is
	// the only reliable presence signal. The app creates the parent dir
	// on first launch.
	if _, statErr := os.Stat(filepath.Dir(path)); statErr == nil {
		d.Installed = true
	}

	cfg, exists, err := readConfig(path)
	if err != nil {
		return d, err
	}
	d.ConfigExists = exists
	if exists {
		d.HasEverMeEntry = nestedMcpServersHasEntry(cfg, claudeCodeServersPath, mcpEntryName)
	}
	return d, nil
}

// claudeDesktopConfigPath returns the OS-specific config file location.
// EVERCLI_CLAUDE_DESKTOP_CONFIG_DIR (used by tests) overrides the parent
// dir on every OS.
func claudeDesktopConfigPath() (string, error) {
	if dir := os.Getenv("EVERCLI_CLAUDE_DESKTOP_CONFIG_DIR"); dir != "" {
		return filepath.Join(dir, claudeDesktopConfigFile), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", output.IOErr("claude-desktop", "resolve-home", err)
	}
	switch runtimeGOOS() {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Claude", claudeDesktopConfigFile), nil
	case "windows":
		// On Windows, Claude Desktop writes under %APPDATA% (the
		// Roaming profile). os.UserConfigDir() returns the right value
		// natively, so prefer it; fall back to %USERPROFILE%\AppData\
		// Roaming only when UserConfigDir errors out (rare).
		if appdata, err := os.UserConfigDir(); err == nil && appdata != "" {
			return filepath.Join(appdata, "Claude", claudeDesktopConfigFile), nil
		}
		return filepath.Join(home, "AppData", "Roaming", "Claude", claudeDesktopConfigFile), nil
	default:
		// Linux + others. Anthropic's experimental Linux build uses an
		// XDG-style path; non-Linux Unix variants share it.
		return filepath.Join(home, ".config", "claude-desktop", claudeDesktopConfigFile), nil
	}
}

// newClaudeDesktopWriter returns the mcpWriter under
// PlatformClaudeDesktop. Same JSON shape as Cursor / Claude Code, so all
// the upsert / TOCTOU / atomic-write machinery from mcp.go is reused
// verbatim.
func newClaudeDesktopWriter() Writer {
	return newMCPWriter(PlatformClaudeDesktop)
}
