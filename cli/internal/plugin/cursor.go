// Package plugin — Cursor support.
//
// Cursor exposes the same JSON `mcpServers.<name>` shape as Claude Code,
// so the writer is just `mcpWriter` with the canonical `mcpServers` path.
// Only the config-file location is Cursor-specific (~/.cursor/mcp.json on
// every OS — Cursor itself canonicalises the path).
//
// EVERCLI_CURSOR_CONFIG_DIR lets tests point at a tmp dir; production
// always resolves under $HOME.
package plugin

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"

	"evercli/internal/output"
)

type cursorDetector struct{}

func (cursorDetector) Platform() Platform { return PlatformCursor }

func (cursorDetector) DisplayName() string { return "Cursor" }

func (cursorDetector) Detect(_ context.Context) (*Detection, error) {
	path, err := cursorConfigPath()
	if err != nil {
		return &Detection{Platform: PlatformCursor, DisplayName: "Cursor"}, nil
	}
	d := &Detection{
		Platform:    PlatformCursor,
		DisplayName: "Cursor",
		ConfigPath:  path,
	}

	// "Installed" means Cursor is on the box. Two heuristics — either
	// works. Most users open Cursor from the GUI so the CLI isn't
	// always on PATH; the config dir is the more reliable signal.
	if home, err := os.UserHomeDir(); err == nil {
		if _, statErr := os.Stat(filepath.Join(home, ".cursor")); statErr == nil {
			d.Installed = true
		}
	}
	if !d.Installed {
		if _, err := exec.LookPath("cursor"); err == nil {
			d.Installed = true
		}
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

// cursorConfigPath resolves ~/.cursor/mcp.json with an optional dir
// override for tests. Cursor uses the same path on macOS / Linux /
// Windows ($HOME or %USERPROFILE% — both Go-resolvable via UserHomeDir).
func cursorConfigPath() (string, error) {
	if dir := os.Getenv("EVERCLI_CURSOR_CONFIG_DIR"); dir != "" {
		return filepath.Join(dir, "mcp.json"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", output.IOErr("cursor", "resolve-home", err)
	}
	return filepath.Join(home, ".cursor", "mcp.json"), nil
}

// newCursorWriter returns the mcpWriter under PlatformCursor — the JSON
// shape is identical to Claude Code's `mcpServers` map, so all the
// upsert / TOCTOU / atomic-write machinery from mcp.go is reused
// verbatim.
func newCursorWriter() Writer {
	return newMCPWriter(PlatformCursor)
}
