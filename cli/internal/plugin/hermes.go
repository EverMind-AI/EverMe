// Package plugin — Hermes support (provider mode).
//
// Hermes (NousResearch/hermes-agent, Python) supports native memory
// providers discovered from $HERMES_HOME/plugins/<name>/ (upgrade-safe,
// user-level). evercli installs the EverMe MemoryProvider there:
//
//	writer.Commit
//	  → writeProviderFiles($HERMES_HOME/plugins/everme/)  (embedded python)
//	  → writeEvermeEnv($HERMES_HOME/everme.env, 0600)      (evt credentials)
//	  → config.yaml: memory.provider=everme                (activate provider)
//	  → delete mcp_servers.everme                          (supersede V1.x MCP)
//
//	writer.Verify
//	  → plugins/everme/__init__.py exists AND memory.provider==everme.
//
// This replaces the prior MCP-mode install (mcp_servers.everme), which
// depended on the model voluntarily calling mem_save_* tools. The provider
// captures every turn via framework hooks (sync_turn / on_session_end).
package plugin

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"

	"gopkg.in/yaml.v3"

	"evercli/internal/core"
	"evercli/internal/output"
)

// hermesMcpEntryName is the legacy mcp_servers key the V1.x MCP install
// owned. Provider mode no longer writes it; the const is retained only so
// removeLegacyMcpEntry can delete a leftover entry during migration.
const hermesMcpEntryName = "everme"

// hermesCommand resolves the `hermes` CLI. Delegates to the shared
// core resolver so internal/importer can reuse the same logic without
// importing internal/plugin.
func hermesCommand() string { return core.HermesCommand() }

// hermesHome resolves the Hermes home directory using the four-step
// priority chain in core.HermesHome (EVERCLI_HERMES_CONFIG_DIR →
// HERMES_HOME → `hermes config path` → $HOME/.hermes). Delegates so
// internal/importer can call core directly without importing this package.
func hermesHome() (string, error) { return core.HermesHome() }

// hermesConfigPath returns the absolute path to Hermes's config.yaml,
// resolved via hermesHome's four-step priority chain.
func hermesConfigPath() (string, error) {
	home, err := hermesHome()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "config.yaml"), nil
}

// ---- detector ------------------------------------------------------

type hermesDetector struct{}

func (hermesDetector) Platform() Platform { return PlatformHermes }

func (hermesDetector) DisplayName() string { return "Hermes" }

func (hermesDetector) Detect(_ context.Context) (*Detection, error) {
	path, err := hermesConfigPath()
	if err != nil {
		return &Detection{Platform: PlatformHermes, DisplayName: "Hermes"}, nil
	}
	d := &Detection{
		Platform:    PlatformHermes,
		DisplayName: "Hermes",
		ConfigPath:  path,
	}

	// Dual heuristic, same shape as cursor.go: presence of the
	// resolved Hermes home directory or `hermes` on PATH. We must
	// use hermesHome() rather than hard-coding ~/.hermes so users
	// with HERMES_HOME / `hermes config path` overrides aren't
	// reported as "not installed" simply because their home is in
	// a non-default location. The home value is the same one
	// hermesConfigPath() uses to write, so detection and write paths
	// agree on the target.
	if home, err := hermesHome(); err == nil {
		if _, statErr := os.Stat(home); statErr == nil {
			d.Installed = true
		}
	}
	if !d.Installed {
		if _, err := exec.LookPath(hermesCommand()); err == nil {
			d.Installed = true
		}
	}

	cfg, exists, err := readHermesConfig(path)
	if err != nil {
		return d, err
	}
	d.ConfigExists = exists
	if home, herr := hermesHome(); herr == nil {
		d.HasEverMeEntry = hermesProviderInstalled(home, cfg)
	}
	return d, nil
}

// ---- writer --------------------------------------------------------

// hermesWriter implements Writer + Verifier. It does NOT implement
// Preparer: unlike Codex's marketplace step, Hermes has no out-of-band
// registration phase — the embedded Python provider IS the install, and
// it lands atomically in Commit.
type hermesWriter struct{}

func newHermesWriter() *hermesWriter { return &hermesWriter{} }

func (*hermesWriter) Remove(_ context.Context, configPath string) (*RemoveResult, error) {
	abs, err := filepath.Abs(configPath)
	if err != nil {
		return nil, output.IOErr(configPath, "abs-path", err)
	}
	cfg, exists, err := readHermesConfig(abs)
	if err != nil {
		return nil, err
	}
	home := filepath.Dir(abs)
	result := &RemoveResult{Platform: PlatformHermes, ConfigPath: abs}
	changed := false
	if exists {
		if memory, ok := cfg["memory"].(map[string]interface{}); ok {
			if provider, _ := memory["provider"].(string); provider == "everme" {
				delete(memory, "provider")
				changed = true
			}
		}
		if servers, ok := cfg["mcp_servers"].(map[string]interface{}); ok {
			if _, ok := servers[hermesMcpEntryName]; ok {
				delete(servers, hermesMcpEntryName)
				changed = true
			}
		}
	}
	pluginDir := filepath.Join(home, "plugins", "everme")
	envPath := filepath.Join(home, "everme.env")
	if _, statErr := os.Stat(pluginDir); statErr == nil {
		changed = true
	}
	if _, statErr := os.Stat(envPath); statErr == nil {
		changed = true
	}
	if !changed {
		return result, nil
	}
	if exists && (cfg != nil) {
		// protected=true: the config may still carry a legacy
		// mcp_servers entry with a live agent token.
		backup, berr := backupFile(abs, true)
		if berr != nil {
			return nil, berr
		}
		// Our token is gone from cfg by now, so leave the host's mode alone.
		if err := writeHermesConfig(abs, cfg, configHasNoToken); err != nil {
			return nil, err
		}
		result.BackupPath = backup
	}
	if err := os.RemoveAll(pluginDir); err != nil {
		return nil, output.IOErr(pluginDir, "remove-plugin", err)
	}
	if err := os.Remove(envPath); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, output.IOErr(envPath, "remove-env", err)
	}
	result.Removed = true
	return result, nil
}

func (*hermesWriter) Platform() Platform { return PlatformHermes }

// Plan reads ~/.hermes/config.yaml to decide WillCreate / WillReplace
// and stages a single BackupPath. The TOCTOU snapshot (mtime+size) is
// taken here so Commit refuses to overwrite if Hermes itself (or
// another evercli) wrote between Plan and Commit.
//
// Returns an error rather than overwriting if the existing file is
// malformed YAML — the user should fix it manually rather than have
// us silently destroy data.
func (*hermesWriter) Plan(_ context.Context, configPath string) (*WritePlan, error) {
	if configPath == "" {
		return nil, output.Invalid("configPath is required", "")
	}
	abs, err := filepath.Abs(configPath)
	if err != nil {
		return nil, output.IOErr(configPath, "abs-path", err)
	}

	plan := &WritePlan{Platform: PlatformHermes, ConfigPath: abs}

	parent := filepath.Dir(abs)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return nil, output.IOErr(parent, "mkdir-parent", err)
	}

	cfg, exists, err := readHermesConfig(abs)
	if err != nil {
		return nil, err
	}
	plan.WillCreate = !exists
	plan.WillReplace = hermesProviderInstalled(parent, cfg)
	if exists {
		plan.BackupPath = abs + backupSuffix
		if info, statErr := os.Stat(abs); statErr == nil {
			plan.SnapshotModTime = info.ModTime().UnixNano()
			plan.SnapshotSize = info.Size()
		}
	}

	plan.PreviewEntry = map[string]interface{}{
		"memory.provider": "everme",
		"plugins/everme/": "<embedded python provider>",
		"everme.env":      "EVERME_AGENT_TOKEN=<assigned-on-commit>",
	}
	return plan, nil
}

// Commit writes the embedded Python provider, credentials env file, and
// updates config.yaml to provider-mode: sets memory.provider=everme and
// removes the legacy mcp_servers.everme entry.
func (*hermesWriter) Commit(_ context.Context, plan *WritePlan, params WriteParams) (*WriteResult, error) {
	if plan == nil {
		return nil, output.Internal(fmt.Errorf("nil plan"))
	}
	if err := assertNoConcurrentChange(plan); err != nil {
		return nil, err
	}

	home := filepath.Dir(plan.ConfigPath)

	// 1. Materialize the embedded Python provider into $HERMES_HOME/plugins/everme/.
	if err := writeProviderFiles(filepath.Join(home, "plugins")); err != nil {
		return nil, err
	}

	// 2. Write credentials to $HERMES_HOME/everme.env (0600).
	if err := writeEvermeEnv(filepath.Join(home, "everme.env"), params); err != nil {
		return nil, err
	}

	// 3. Update config.yaml: set memory.provider=everme, drop legacy mcp_servers.everme.
	cfg, exists, err := readHermesConfig(plan.ConfigPath)
	if err != nil {
		return nil, err
	}
	wroteBackup := ""
	if exists && plan.BackupPath != "" {
		raw, rerr := os.ReadFile(plan.ConfigPath)
		if rerr != nil {
			return nil, output.IOErr(plan.ConfigPath, "read-for-backup", rerr)
		}
		if werr := os.WriteFile(plan.BackupPath, raw, 0o600); werr != nil {
			return nil, output.IOErr(plan.BackupPath, "write-backup", werr)
		}
		wroteBackup = plan.BackupPath
	}
	if cfg == nil {
		cfg = map[string]interface{}{}
	}
	if err := setMemoryProvider(cfg, "everme"); err != nil {
		return nil, err
	}
	removeLegacyMcpEntry(cfg)
	// config.yaml only selects the provider; the credential goes to
	// everme.env (writeEvermeEnv, 0600).
	if err := writeHermesConfig(plan.ConfigPath, cfg, configHasNoToken); err != nil {
		return nil, err
	}

	return &WriteResult{
		Platform:      PlatformHermes,
		ConfigPath:    plan.ConfigPath,
		BackupPath:    wroteBackup,
		WroteNewEntry: !plan.WillReplace,
	}, nil
}

// writeEvermeEnv writes the three EVERME_* credentials as KEY=VALUE lines
// at mode 0600. The provider's config.py reads this file (priority 3).
func writeEvermeEnv(path string, params WriteParams) error {
	body := fmt.Sprintf(
		"EVERME_API_BASE=%s\nEVERME_AGENT_ID=%s\nEVERME_AGENT_TOKEN=%s\n",
		params.APIBaseURL, params.AgentID, params.AgentToken,
	)
	if err := writeFileAtomic(path, []byte(body), 0o600); err != nil {
		return output.IOErr(path, "write-everme-env", err)
	}
	return nil
}

// setMemoryProvider sets cfg.memory.provider = name, preserving other
// memory.* keys. Refuses to overwrite if memory is a non-map.
func setMemoryProvider(cfg map[string]interface{}, name string) error {
	var mem map[string]interface{}
	if raw, present := cfg["memory"]; present && raw != nil {
		m, ok := raw.(map[string]interface{})
		if !ok {
			return output.Invalid(
				fmt.Sprintf("memory has type %T; expected an object — fix config manually", raw), "")
		}
		mem = m
	} else {
		mem = map[string]interface{}{}
	}
	cfg["memory"] = mem
	mem["provider"] = name
	return nil
}

// removeLegacyMcpEntry deletes mcp_servers.everme (the V1.x MCP-mode
// entry) since the provider supersedes it. Sibling MCP servers and the
// mcp_servers map itself round-trip untouched.
func removeLegacyMcpEntry(cfg map[string]interface{}) {
	servers, ok := cfg["mcp_servers"].(map[string]interface{})
	if !ok {
		return
	}
	delete(servers, hermesMcpEntryName)
}

// Verify re-reads the on-disk YAML and asserts the provider mode is
// correctly installed: plugins/everme/__init__.py exists and
// memory.provider=everme is set in config.yaml.
func (*hermesWriter) Verify(_ context.Context, result *WriteResult) error {
	if result == nil {
		return output.Internal(fmt.Errorf("nil result"))
	}
	home := filepath.Dir(result.ConfigPath)
	cfg, exists, err := readHermesConfig(result.ConfigPath)
	if err != nil {
		return err
	}
	if !exists {
		return output.IOErr(result.ConfigPath, "verify", fmt.Errorf("config file missing after Commit"))
	}
	if !hermesProviderInstalled(home, cfg) {
		return output.IOErr(result.ConfigPath, "verify",
			fmt.Errorf("provider not installed: plugins/everme or memory.provider=everme missing"))
	}
	return nil
}

// ---- helpers --------------------------------------------------------

// readHermesConfig parses the YAML config at path. Returns (cfg, exists, err).
// Missing file → (nil, false, nil). Malformed YAML → IO error so the
// user knows to fix it manually rather than have us silently overwrite.
//
// yaml.v3 unmarshalling into map[string]interface{} yields
// map[string]interface{} for nested mappings (unlike yaml.v2's
// map[interface{}]interface{}), so the rest of the writer can use
// plain string keys without type-assertion gymnastics.
func readHermesConfig(path string) (map[string]interface{}, bool, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, false, nil
		}
		return nil, false, output.IOErr(path, "read", err)
	}
	if len(raw) == 0 {
		return map[string]interface{}{}, true, nil
	}
	var cfg map[string]interface{}
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		ce := output.IOErr(path, "parse-yaml", err)
		ce.Hint = "Config is not valid YAML; fix it manually before re-running"
		return nil, true, ce
	}
	if cfg == nil {
		cfg = map[string]interface{}{}
	}
	return cfg, true, nil
}

// writeHermesConfig serialises cfg as YAML (2-space indent matching
// hermes_cli/mcp_config.py's save_config output) and atomically replaces
// path. Mode selection follows configWriteMode; the caller says whether
// cfg holds a credential (config.yaml does not — the token lives in
// everme.env, written separately at 0600).
func writeHermesConfig(path string, cfg map[string]interface{}, secrecy configSecrecy) error {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(cfg); err != nil {
		_ = enc.Close()
		return output.Internal(fmt.Errorf("marshal yaml: %w", err))
	}
	if err := enc.Close(); err != nil {
		return output.Internal(fmt.Errorf("close yaml encoder: %w", err))
	}

	return writeConfigFileAtomic(path, buf.Bytes(), secrecy)
}

// hermesProviderInstalled reports whether the EverMe provider is wired:
// the plugin package exists AND config.yaml selects memory.provider=everme.
func hermesProviderInstalled(home string, cfg map[string]interface{}) bool {
	if _, err := os.Stat(filepath.Join(home, "plugins", "everme", "__init__.py")); err != nil {
		return false
	}
	mem, ok := cfg["memory"].(map[string]interface{})
	if !ok {
		return false
	}
	prov, _ := mem["provider"].(string)
	return prov == "everme"
}
