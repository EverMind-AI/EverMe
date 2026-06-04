// Package plugin — Gemini CLI support.
//
// Gemini CLI reads MCP servers from a top-level `mcpServers.<name>` map
// in ~/.gemini/settings.json — the identical JSON shape Cursor and
// Claude Desktop use. So the writer is the shared mcpWriter; only the
// config-file location is Gemini-specific.
//
// EVERCLI_GEMINI_CONFIG_DIR lets tests point at a tmp dir; production
// always resolves under $HOME.
//
// Caveat (documented, not auto-handled): if the user has set
// `mcp.allowed` in settings.json, only listed server names connect —
// they must add "everme-memory" to it by hand.
package plugin

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"

	"evercli/internal/output"
)

type geminiDetector struct{}

func (geminiDetector) Platform() Platform { return PlatformGemini }

func (geminiDetector) DisplayName() string { return "Gemini CLI" }

func (geminiDetector) Detect(_ context.Context) (*Detection, error) {
	path, err := geminiConfigPath()
	if err != nil {
		return &Detection{Platform: PlatformGemini, DisplayName: "Gemini CLI"}, nil
	}
	d := &Detection{
		Platform:    PlatformGemini,
		DisplayName: "Gemini CLI",
		ConfigPath:  path,
	}

	// "Installed" = Gemini CLI is on the box. Dir-based signal first
	// (most reliable), CLI-on-PATH as fallback — same pattern as cursor.go.
	if home, err := os.UserHomeDir(); err == nil {
		if _, statErr := os.Stat(filepath.Join(home, ".gemini")); statErr == nil {
			d.Installed = true
		}
	}
	if !d.Installed {
		if _, err := exec.LookPath("gemini"); err == nil {
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

// geminiConfigPath resolves ~/.gemini/settings.json with an optional dir
// override for tests.
func geminiConfigPath() (string, error) {
	if dir := os.Getenv("EVERCLI_GEMINI_CONFIG_DIR"); dir != "" {
		return filepath.Join(dir, "settings.json"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", output.IOErr("gemini", "resolve-home", err)
	}
	return filepath.Join(home, ".gemini", "settings.json"), nil
}

// newGeminiWriter returns the shared mcpWriter under PlatformGemini —
// the `mcpServers` JSON shape is identical to Cursor / Claude Desktop,
// so all upsert / TOCTOU / atomic-write machinery from mcp.go is reused
// verbatim. The entry name is the canonical `everme-memory`.
func newGeminiWriter() Writer {
	return newMCPWriter(PlatformGemini)
}
