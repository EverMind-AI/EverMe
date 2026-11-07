// Package plugin — SeekMoon support.
//
// SeekMoon (moonbitlang/openseek) is a desktop agent whose engine reads MCP
// servers from a JSON file with the same top-level `mcpServers.<name>` shape as
// Claude Desktop, so the writer reuses `mcpWriter` verbatim. What differs is
// where that file lives: the desktop keeps it in its runtime directory, next to
// `engine-settings.json`.
//
//	macOS   ~/Library/Application Support/SeekMoon/host-mcp.json
//	Windows %APPDATA%\SeekMoon\host-mcp.json
//	Linux   ~/.config/SeekMoon/host-mcp.json
//
// SeekMoon also writes its own `seekmoon` entry into that same file — the
// desktop's tool server, reachable at a per-launch localhost URL. The shared
// upsert in mcp.go only touches `mcpServers.<mcpEntryName>`, so the desktop's
// entry and any server the user added by hand survive the install unchanged.
//
// EVERCLI_SEEKMOON_CONFIG_DIR pins the runtime directory (tests), and
// EVERCLI_SEEKMOON_APP_PATH pins the macOS bundle path.
package plugin

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"

	"evercli/internal/output"
)

// seekMoonConfigFile is the only file SeekMoon reads user MCP servers from.
// `engine-settings.json` next to it holds model/provider settings; `skills/`
// and `schedules/` are the app's own state. Do not probe alternatives.
const seekMoonConfigFile = "host-mcp.json"

type seekMoonDetector struct{}

func (seekMoonDetector) Platform() Platform { return PlatformSeekMoon }

func (seekMoonDetector) DisplayName() string { return "SeekMoon" }

func (seekMoonDetector) Detect(_ context.Context) (*Detection, error) {
	dir, err := seekMoonConfigDir()
	if err != nil {
		return &Detection{Platform: PlatformSeekMoon, DisplayName: "SeekMoon"}, nil
	}
	detection := &Detection{
		Platform:    PlatformSeekMoon,
		DisplayName: "SeekMoon",
		ConfigPath:  seekMoonConfigPathInDir(dir),
		Installed:   seekMoonInstalled(dir),
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

func seekMoonConfigPath() (string, error) {
	dir, err := seekMoonConfigDir()
	if err != nil {
		return "", err
	}
	return seekMoonConfigPathInDir(dir), nil
}

func seekMoonConfigPathInDir(dir string) string {
	return filepath.Join(dir, seekMoonConfigFile)
}

// seekMoonConfigDir resolves SeekMoon's runtime directory. The desktop creates
// it on first launch; the layout mirrors the app's own resolution so an install
// lands where the engine actually reads.
func seekMoonConfigDir() (string, error) {
	if dir := os.Getenv("EVERCLI_SEEKMOON_CONFIG_DIR"); dir != "" {
		return dir, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", output.IOErr("seekmoon", "resolve-home", err)
	}
	switch runtimeGOOS() {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "SeekMoon"), nil
	case "windows":
		// The desktop uses the Roaming profile for its runtime directory;
		// os.UserConfigDir() already points there on Windows.
		if appdata, err := os.UserConfigDir(); err == nil && appdata != "" {
			return filepath.Join(appdata, "SeekMoon"), nil
		}
		return filepath.Join(home, "AppData", "Roaming", "SeekMoon"), nil
	default:
		return filepath.Join(home, ".config", "SeekMoon"), nil
	}
}

// seekMoonInstalled reports whether SeekMoon is on this machine. A desktop app
// has no canonical CLI, so the runtime directory and the macOS bundle are the
// presence signals; `seekmoon` / `openseek` on PATH covers the CLI-only
// installs that ship next to the desktop build.
func seekMoonInstalled(configDir string) bool {
	if _, err := os.Stat(configDir); err == nil {
		return true
	}
	if appPath := os.Getenv("EVERCLI_SEEKMOON_APP_PATH"); appPath != "" {
		if _, err := os.Stat(appPath); err == nil {
			return true
		}
		// Stale override: fall through to the PATH / darwin probes
		// instead of declaring SeekMoon absent outright.
	}
	for _, name := range []string{"seekmoon", "openseek"} {
		if _, err := exec.LookPath(name); err == nil {
			return true
		}
	}
	if runtimeGOOS() == "darwin" {
		for _, path := range []string{"/Applications/SeekMoon.app", filepath.Join(os.Getenv("HOME"), "Applications", "SeekMoon.app")} {
			if _, err := os.Stat(path); err == nil {
				return true
			}
		}
	}
	return false
}

// seekMoonWriter wraps the shared mcpWriter to say when the entry takes effect.
// SeekMoon connects its MCP servers once per engine process and reuses those
// connections across turns: a desktop conversation runs its own engine, spawned
// with `--mcp-config=<runtime>/host-mcp.json`, and connects at startup
// (internal/openseek/serve/loop.mbt). A config written now is therefore picked
// up by the next engine — a new conversation, or a relaunch of the app.
type seekMoonWriter struct {
	*mcpWriter
}

func newSeekMoonWriter() Writer {
	return seekMoonWriter{newMCPWriter(PlatformSeekMoon)}
}

func (w seekMoonWriter) Commit(ctx context.Context, plan *WritePlan, params WriteParams) (*WriteResult, error) {
	res, err := w.mcpWriter.Commit(ctx, plan, params)
	if res != nil {
		res.NextSteps = append(res.NextSteps,
			"start a new conversation in SeekMoon (or relaunch the app): a conversation's engine connects its MCP servers once at startup and keeps them for its lifetime, so this conversation will not see everme-memory")
	}
	return res, err
}
