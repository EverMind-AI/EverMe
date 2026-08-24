package plugin

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"

	"evercli/internal/output"
)

type devinDetector struct{}

func (devinDetector) Platform() Platform { return PlatformDevin }

func (devinDetector) DisplayName() string { return "Devin" }

func (devinDetector) Detect(_ context.Context) (*Detection, error) {
	path, err := devinConfigPath()
	if err != nil {
		return &Detection{Platform: PlatformDevin, DisplayName: "Devin"}, nil
	}
	detection := &Detection{
		Platform:    PlatformDevin,
		DisplayName: "Devin",
		ConfigPath:  path,
	}
	if home, err := os.UserHomeDir(); err == nil {
		for _, candidate := range []string{
			filepath.Join(home, "Applications", "Devin.app"),
			"/Applications/Devin.app",
			filepath.Join(home, ".config", "devin", "config.json"),
		} {
			if _, statErr := os.Stat(candidate); statErr == nil {
				detection.Installed = true
				break
			}
		}
	}
	if !detection.Installed {
		if _, err := exec.LookPath("devin"); err == nil {
			detection.Installed = true
		}
	}
	// An install made before Devin moved its config still lives in the
	// Windsurf tree. Report where the entry actually is so `plugin list`
	// and uninstall act on the file that holds the token.
	for _, candidate := range append([]string{path}, devinLegacyConfigPaths()...) {
		cfg, exists, err := readConfig(candidate)
		if err != nil {
			return detection, err
		}
		if !exists {
			continue
		}
		hasEntry := nestedMcpServersHasEntry(cfg, claudeCodeServersPath, mcpEntryName)
		if candidate == path || hasEntry {
			detection.ConfigPath = candidate
			detection.ConfigExists = true
			detection.HasEverMeEntry = hasEntry
		}
		if hasEntry {
			break
		}
	}
	return detection, nil
}

// devinConfigPath is Devin's current user config location. Devin moved
// out of the Windsurf tree: launching it with an MCP config still at
// ~/.codeium/windsurf pops a dialog offering to copy it to
// ~/.config/devin, and accepting leaves the agent token in a second file.
// Note hooks do NOT live beside it — see devinHooksPath.
func devinConfigPath() (string, error) {
	if dir := os.Getenv("EVERCLI_DEVIN_CONFIG_DIR"); dir != "" {
		return filepath.Join(dir, "mcp_config.json"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", output.IOErr("devin", "resolve-home", err)
	}
	return filepath.Join(home, ".config", "devin", "mcp_config.json"), nil
}

// devinHooksPath is where Devin's hook discovery looks, which is NOT
// beside mcp_config.json: config moved to ~/.config/devin but hooks are
// still loaded from the Windsurf tree by the "windsurf" provider. A real
// session with hooks in both places logged
// `loaded=7 (global=7 cascade=0)` — every hook came from the Windsurf
// tree, none from ~/.config/devin.
// The split only applies to the canonical install: asked to write some
// other config, keep hooks beside it rather than reaching into the user's
// real Windsurf tree — the same scoping mistake the legacy sweep made.
func devinHooksPath(configPath string) string {
	beside := filepath.Join(filepath.Dir(configPath), "hooks.json")
	if os.Getenv("EVERCLI_DEVIN_CONFIG_DIR") != "" {
		return beside
	}
	canonical, err := devinConfigPath()
	if err != nil || canonical != configPath {
		return beside
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return beside
	}
	return filepath.Join(home, ".codeium", "windsurf", "hooks.json")
}

// devinLegacyConfigPaths are locations earlier installs wrote to. They
// are never written again, only detected and cleaned up.
func devinLegacyConfigPaths() []string {
	if os.Getenv("EVERCLI_DEVIN_CONFIG_DIR") != "" {
		return nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	return []string{filepath.Join(home, ".codeium", "windsurf", "mcp_config.json")}
}

func newDevinWriter() Writer {
	return newDevinHookWriter()
}

func newDevinHookWriter() *nativeHookWriter {
	return newNativeHookWriter(
		PlatformDevin,
		devinHooksPath,
		func(cfg map[string]interface{}) error {
			// The events a real Devin session emits: the question, the
			// tool call, and the answer. post_cascade_response_with_transcript
			// is still registered because an older Devin emits that one
			// instead — the hook ignores whichever never arrives.
			var specs []hookSpec
			for _, event := range []string{
				"pre_user_prompt",
				"post_run_command",
				"post_read_code",
				"post_cascade_response",
				"post_cascade_response_with_transcript",
			} {
				specs = append(specs, hookSpec{
					Event: event,
					Entry: map[string]interface{}{
						"command":     "npx -y @everme/devin@latest hook " + event,
						"show_output": false,
					},
				})
			}
			if err := mergeFlatHooks(cfg, "@everme/windsurf", specs); err != nil {
				return err
			}
			return mergeFlatHooks(cfg, "@everme/devin", specs)
		},
	).withLegacyCleanup(devinConfigPath, devinLegacyConfigPaths)
}
