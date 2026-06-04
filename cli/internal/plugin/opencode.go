// Package plugin — opencode support.
//
// opencode (sst/opencode) reads MCP servers from a top-level `mcp.<name>`
// map in ~/.config/opencode/opencode.json. The entry shape differs from
// the Cursor / Claude Desktop `mcpServers` family:
//
//	"mcp": {
//	  "everme-memory": {
//	    "type": "local",
//	    "command": ["npx", "-y", "@everme/memory-mcp"],
//	    "environment": {EVERME_API_BASE, EVERME_AGENT_ID, EVERME_AGENT_TOKEN},
//	    "enabled": true
//	  }
//	}
//
// command is an argv array, the env field is `environment` (not `env`),
// and there are `type`/`enabled` fields — so we can't reuse mcpWriter's
// buildEntry. We DO reuse the shared JSON read / atomic-write / TOCTOU /
// upsert helpers from mcp.go. The entry key is the canonical
// `everme-memory` (mcpEntryName), same as the Cursor/Gemini family.
//
// We only write opencode.json (not opencode.jsonc): round-tripping JSONC
// comments through encoding/json is lossy. Documented caveat.
//
// install-only, like every other host: no Preparer (opencode has no
// marketplace) and no Verifier in V1.
package plugin

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"evercli/internal/output"
)

// opencodeServersPath is the key chain to opencode's MCP server map.
var opencodeServersPath = []string{"mcp"}

// opencodeConfigPath resolves the global opencode config:
// EVERCLI_OPENCODE_CONFIG_DIR (test/override) → $XDG_CONFIG_HOME/opencode
// → ~/.config/opencode. Always the opencode.json basename (we do not
// write opencode.jsonc).
func opencodeConfigPath() (string, error) {
	if dir := os.Getenv("EVERCLI_OPENCODE_CONFIG_DIR"); dir != "" {
		return filepath.Join(dir, "opencode.json"), nil
	}
	if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
		return filepath.Join(xdg, "opencode", "opencode.json"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", output.IOErr("opencode", "resolve-home", err)
	}
	return filepath.Join(home, ".config", "opencode", "opencode.json"), nil
}

// ---- detector ------------------------------------------------------

type opencodeDetector struct{}

func (opencodeDetector) Platform() Platform { return PlatformOpenCode }

func (opencodeDetector) DisplayName() string { return "opencode" }

func (opencodeDetector) Detect(_ context.Context) (*Detection, error) {
	path, err := opencodeConfigPath()
	if err != nil {
		return &Detection{Platform: PlatformOpenCode, DisplayName: "opencode"}, nil
	}
	d := &Detection{
		Platform:    PlatformOpenCode,
		DisplayName: "opencode",
		ConfigPath:  path,
	}

	// Dual heuristic: config dir present, or `opencode` on PATH.
	if _, statErr := os.Stat(filepath.Dir(path)); statErr == nil {
		d.Installed = true
	}
	if !d.Installed {
		if _, err := exec.LookPath("opencode"); err == nil {
			d.Installed = true
		}
	}

	cfg, exists, err := readConfig(path)
	if err != nil {
		return d, err
	}
	d.ConfigExists = exists
	if exists {
		d.HasEverMeEntry = opencodeHasEverMeEntry(cfg)
	}
	return d, nil
}

// ---- writer --------------------------------------------------------

// opencodeWriter implements Writer only (no Preparer, no Verifier).
type opencodeWriter struct{}

func newOpenCodeWriter() *opencodeWriter { return &opencodeWriter{} }

func (*opencodeWriter) Platform() Platform { return PlatformOpenCode }

// Plan reads opencode.json to decide WillCreate / WillReplace, stages a
// single BackupPath, and snapshots mtime/size for the TOCTOU check.
func (*opencodeWriter) Plan(_ context.Context, configPath string) (*WritePlan, error) {
	if configPath == "" {
		return nil, output.Invalid("configPath is required", "")
	}
	abs, err := filepath.Abs(configPath)
	if err != nil {
		return nil, output.IOErr(configPath, "abs-path", err)
	}

	plan := &WritePlan{Platform: PlatformOpenCode, ConfigPath: abs}

	parent := filepath.Dir(abs)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return nil, output.IOErr(parent, "mkdir-parent", err)
	}

	cfg, exists, err := readConfig(abs)
	if err != nil {
		return nil, err
	}
	plan.WillCreate = !exists
	plan.WillReplace = opencodeHasEverMeEntry(cfg)
	if exists {
		plan.BackupPath = abs + backupSuffix
		if info, statErr := os.Stat(abs); statErr == nil {
			plan.SnapshotModTime = info.ModTime().UnixNano()
			plan.SnapshotSize = info.Size()
		}
	}

	plan.PreviewEntry = buildOpenCodeEntry(
		"https://api.everme.evermind.ai",
		"agt_<assigned-on-commit>",
		"evt_<assigned-on-commit>",
	)
	return plan, nil
}

// Commit upserts mcp.everme-memory, preserving every other top-level key
// and every sibling mcp.* entry. Atomic write via the shared
// writeConfigAtomic (JSON MarshalIndent → .tmp → fsync → rename).
func (*opencodeWriter) Commit(_ context.Context, plan *WritePlan, params WriteParams) (*WriteResult, error) {
	if plan == nil {
		return nil, output.Internal(fmt.Errorf("nil plan"))
	}
	if err := assertNoConcurrentChange(plan); err != nil {
		return nil, err
	}

	cfg, exists, err := readConfig(plan.ConfigPath)
	if err != nil {
		return nil, err
	}

	wroteBackup := ""
	if exists && plan.BackupPath != "" {
		raw, err := os.ReadFile(plan.ConfigPath)
		if err != nil {
			return nil, output.IOErr(plan.ConfigPath, "read-for-backup", err)
		}
		if err := os.WriteFile(plan.BackupPath, raw, 0o600); err != nil {
			return nil, output.IOErr(plan.BackupPath, "write-backup", err)
		}
		wroteBackup = plan.BackupPath
	}

	if cfg == nil {
		cfg = map[string]interface{}{}
	}
	if err := nestedMcpUpsertEntry(cfg, opencodeServersPath, mcpEntryName, buildOpenCodeEntry(params.APIBaseURL, params.AgentID, params.AgentToken)); err != nil {
		return nil, output.Invalid(
			fmt.Sprintf("config at %s has a shape collision under mcp: %v", plan.ConfigPath, err),
			"Fix the config file's shape manually (the `mcp` key exists with a non-object value), then retry install",
		)
	}

	if err := writeConfigAtomic(plan.ConfigPath, cfg); err != nil {
		return nil, err
	}

	return &WriteResult{
		Platform:      PlatformOpenCode,
		ConfigPath:    plan.ConfigPath,
		BackupPath:    wroteBackup,
		WroteNewEntry: !plan.WillReplace,
	}, nil
}

// ---- helpers -------------------------------------------------------

// buildOpenCodeEntry produces the opencode-flavoured local MCP entry.
// command[0] is npxCommand() so Windows gets npx.cmd.
func buildOpenCodeEntry(apiBaseURL, agentID, agentToken string) map[string]interface{} {
	return map[string]interface{}{
		"type":    "local",
		"command": []interface{}{npxCommand(), "-y", "@everme/memory-mcp"},
		"environment": map[string]interface{}{
			"EVERME_API_BASE":    apiBaseURL,
			"EVERME_AGENT_ID":    agentID,
			"EVERME_AGENT_TOKEN": agentToken,
		},
		"enabled": true,
	}
}

// opencodeHasEverMeEntry reports whether mcp.everme-memory exists with a
// non-empty EVERME_AGENT_TOKEN under `environment`. Mirrors
// hermesHasEverMeEntry — a scaffold without a token reads as "not yet
// configured" so the cmd layer (re)installs rather than skips.
func opencodeHasEverMeEntry(cfg map[string]interface{}) bool {
	if cfg == nil {
		return false
	}
	servers, ok := cfg["mcp"].(map[string]interface{})
	if !ok {
		return false
	}
	entry, ok := servers[mcpEntryName].(map[string]interface{})
	if !ok {
		return false
	}
	env, ok := entry["environment"].(map[string]interface{})
	if !ok {
		return false
	}
	tok, _ := env["EVERME_AGENT_TOKEN"].(string)
	return tok != ""
}
