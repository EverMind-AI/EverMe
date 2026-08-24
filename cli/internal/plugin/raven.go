// Package plugin — Raven support (memory-backend mode).
//
// Raven (EverMind-AI/Raven, Python) discovers external plugins from
// ~/.raven/plugins/<plugin-id>/raven-plugin.toml and selects exactly one
// memory backend via config.json's memory.backend (single-slot, same
// exclusivity as OpenClaw's plugins.slots.contextEngine). evercli
// installs the embedded EverMe backend there:
//
//	writer.Commit
//	  → writeRavenPluginFiles(~/.raven/plugins/everme-memory/)  (embedded python)
//	  → config.json: memory.backend=everme                      (activate backend)
//	  → config.json: plugins.config["everme-memory"]            (evt credentials)
//	  → config.json: drop "everme-memory" from plugins.disabled (un-opt-out)
//
//	writer.Verify
//	  → plugins/everme-memory/raven-plugin.toml exists AND
//	    memory.backend==everme.
//
// The install follows the Hermes precedent (embedded Python dropped into
// the host's user-level plugin dir) with OpenClaw's credential posture
// (evt lives inside the host's own JSON config, not a separate env
// file — config.json is Raven's canonical credential store and already
// holds provider API keys).
//
// Selecting memory.backend=everme supersedes Raven's bundled everos
// backend for the session; Raven core's MEMORY.md / consolidation
// pipeline is unaffected (the backend owns no compaction).
package plugin

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"evercli/internal/output"
)

// RavenPluginID is the Raven plugin id (and plugin directory name) for
// the EverMe memory backend. It MUST match the plugin-side sources of
// truth kept in ravenassets/everme-memory/:
//
//   - raven-plugin.toml : [plugin] id
//   - the config key Raven hands to the factory (plugins.config.<id>)
//
// Raven's discovery scans <user_dir>/<dir>/raven-plugin.toml and warns
// when <dir> != manifest id, so the directory Commit creates uses this
// value too. TestRavenPluginIDConsistency asserts the values stay in
// sync.
const RavenPluginID = "everme-memory"

// ravenBackendName is the memory_backends contribution name the
// manifest declares — the value memory.backend must be set to.
const ravenBackendName = "everme"

// ravenCommand resolves the `raven` CLI binary name/path (`uv tool
// install` drops it at ~/.local/bin/raven). EVERCLI_RAVEN_CMD lets
// tests substitute a fake so detection doesn't depend on the host's
// PATH (same escape hatch as EVERCLI_HERMES_CMD).
func ravenCommand() string {
	if v := os.Getenv("EVERCLI_RAVEN_CMD"); v != "" {
		return v
	}
	return "raven"
}

// RavenHome resolves the Raven home directory: $EVERCLI_RAVEN_CONFIG_DIR
// (tests / non-default installs) → $HOME/.raven. Raven itself hardcodes
// Path.home()/".raven" (raven/config/loader.py), so unlike Hermes there
// is no host-side override chain to mirror.
func RavenHome() (string, error) {
	if dir := os.Getenv("EVERCLI_RAVEN_CONFIG_DIR"); dir != "" {
		return dir, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".raven"), nil
}

// ravenConfigPath returns the absolute path to Raven's config.json.
func ravenConfigPath() (string, error) {
	home, err := RavenHome()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "config.json"), nil
}

// ---- detector ------------------------------------------------------

type ravenDetector struct{}

func (ravenDetector) Platform() Platform { return PlatformRaven }

func (ravenDetector) DisplayName() string { return "Raven" }

func (ravenDetector) Detect(_ context.Context) (*Detection, error) {
	path, err := ravenConfigPath()
	if err != nil {
		return &Detection{Platform: PlatformRaven, DisplayName: "Raven"}, nil
	}
	d := &Detection{
		Platform:    PlatformRaven,
		DisplayName: "Raven",
		ConfigPath:  path,
	}

	// Dual heuristic, same shape as hermes.go: presence of the resolved
	// Raven home directory or `raven` on PATH.
	if home, err := RavenHome(); err == nil {
		if _, statErr := os.Stat(home); statErr == nil {
			d.Installed = true
		}
	}
	if !d.Installed {
		if _, err := exec.LookPath(ravenCommand()); err == nil {
			d.Installed = true
		}
	}

	cfg, exists, err := readConfig(path)
	if err != nil {
		return d, err
	}
	d.ConfigExists = exists
	if home, herr := RavenHome(); herr == nil {
		d.HasEverMeEntry = ravenBackendInstalled(home, cfg)
	}
	return d, nil
}

// ---- writer --------------------------------------------------------

// ravenWriter implements Writer + Verifier. No Preparer: like Hermes,
// there is no out-of-band registration phase — the embedded Python
// backend IS the install, and it lands atomically in Commit.
type ravenWriter struct{}

func newRavenWriter() *ravenWriter { return &ravenWriter{} }

func (*ravenWriter) Remove(_ context.Context, configPath string) (*RemoveResult, error) {
	abs, err := filepath.Abs(configPath)
	if err != nil {
		return nil, output.IOErr(configPath, "abs-path", err)
	}
	cfg, exists, err := readConfig(abs)
	if err != nil {
		return nil, err
	}
	home := filepath.Dir(abs)
	result := &RemoveResult{Platform: PlatformRaven, ConfigPath: abs}
	changed := false
	if exists {
		if memory, ok := cfg["memory"].(map[string]interface{}); ok {
			if backend, _ := memory["backend"].(string); backend == ravenBackendName {
				delete(memory, "backend")
				changed = true
			}
		}
		if plugins, ok := cfg["plugins"].(map[string]interface{}); ok {
			if pluginCfg, ok := plugins["config"].(map[string]interface{}); ok {
				if _, ok := pluginCfg[RavenPluginID]; ok {
					delete(pluginCfg, RavenPluginID)
					changed = true
				}
			}
		}
	}
	pluginDir := filepath.Join(home, "plugins", RavenPluginID)
	if _, statErr := os.Stat(pluginDir); statErr == nil {
		changed = true
	}
	if !changed {
		return result, nil
	}
	if exists {
		// protected=true: Raven's config.json is its canonical
		// credential store, so the backup carries a live agent token.
		backup, berr := backupFile(abs, true)
		if berr != nil {
			return nil, berr
		}
		// Our token is gone from cfg by now, so leave the host's mode alone.
		if err := writeConfigAtomic(abs, cfg, configHasNoToken); err != nil {
			return nil, err
		}
		result.BackupPath = backup
	}
	if err := os.RemoveAll(pluginDir); err != nil {
		return nil, output.IOErr(pluginDir, "remove-plugin", err)
	}
	result.Removed = true
	return result, nil
}

func (*ravenWriter) Platform() Platform { return PlatformRaven }

// Plan reads ~/.raven/config.json to decide WillCreate / WillReplace
// and stages a single BackupPath. The TOCTOU snapshot (mtime+size) is
// taken here so Commit refuses to overwrite if Raven itself (or
// another evercli) wrote between Plan and Commit.
func (*ravenWriter) Plan(_ context.Context, configPath string) (*WritePlan, error) {
	if configPath == "" {
		return nil, output.Invalid("configPath is required", "")
	}
	abs, err := filepath.Abs(configPath)
	if err != nil {
		return nil, output.IOErr(configPath, "abs-path", err)
	}

	plan := &WritePlan{Platform: PlatformRaven, ConfigPath: abs}

	parent := filepath.Dir(abs)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return nil, output.IOErr(parent, "mkdir-parent", err)
	}

	cfg, exists, err := readConfig(abs)
	if err != nil {
		return nil, err
	}
	plan.WillCreate = !exists
	plan.WillReplace = ravenBackendInstalled(parent, cfg)
	if exists {
		plan.BackupPath = abs + backupSuffix
		if info, statErr := os.Stat(abs); statErr == nil {
			plan.SnapshotModTime = info.ModTime().UnixNano()
			plan.SnapshotSize = info.Size()
		}
	}

	// Preview uses placeholders that visibly aren't tokens — Plan output
	// also feeds --dry-run, which a user might paste into an issue.
	plan.PreviewEntry = map[string]interface{}{
		"memory.backend":                 ravenBackendName,
		"plugins/" + RavenPluginID + "/": "<embedded python backend>",
		"plugins.config." + RavenPluginID: buildRavenEntry(
			"https://api.everme.evermind.ai",
			"<assigned-on-commit>",
			"<assigned-on-commit>",
		),
	}
	return plan, nil
}

// Commit writes the embedded Python backend, then updates config.json:
// selects memory.backend=everme, writes the credential entry under
// plugins.config, and removes a leftover plugins.disabled opt-out.
func (*ravenWriter) Commit(_ context.Context, plan *WritePlan, params WriteParams) (*WriteResult, error) {
	if plan == nil {
		return nil, output.Internal(fmt.Errorf("nil plan"))
	}
	if err := assertNoConcurrentChange(plan); err != nil {
		return nil, err
	}

	home := filepath.Dir(plan.ConfigPath)

	// 1. Materialize the embedded Python backend into
	//    ~/.raven/plugins/everme-memory/.
	if err := writeRavenPluginFiles(filepath.Join(home, "plugins")); err != nil {
		return nil, err
	}

	// 2. Update config.json: backend selection + credentials.
	cfg, exists, err := readConfig(plan.ConfigPath)
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

	entry := buildRavenEntry(params.APIBaseURL, params.AgentID, params.AgentToken)
	if upErr := upsertRavenEntry(cfg, entry); upErr != nil {
		return nil, output.Invalid(
			fmt.Sprintf("config at %s has a shape collision under memory.*/plugins.*: %v", plan.ConfigPath, upErr),
			"Fix the config file's shape manually (a memory.* or plugins.* path collides with an unexpected non-object value), then retry install",
		)
	}

	// config.json is Raven's only credential store: it now holds the
	// freshly minted agent_token, and Raven creates it 0644.
	if err := writeConfigAtomic(plan.ConfigPath, cfg, configCarriesToken); err != nil {
		return nil, err
	}

	return &WriteResult{
		Platform:      PlatformRaven,
		ConfigPath:    plan.ConfigPath,
		BackupPath:    wroteBackup,
		WroteNewEntry: !plan.WillReplace,
	}, nil
}

// buildRavenEntry produces the plugins.config.<id> dict Raven hands to
// the plugin factory verbatim. Keys are snake_case (Raven's plugin
// config convention — mirrors the bundled everos-memory seed) and the
// manifest's defaults are inlined so a fresh install yields a
// fully-specified entry instead of relying on the plugin's runtime
// defaults — auditors reading the JSON should see the entire effective
// config.
func buildRavenEntry(apiBaseURL, agentID, agentToken string) map[string]interface{} {
	return map[string]interface{}{
		"api_base":          apiBaseURL,
		"agent_id":          agentID,
		"agent_token":       agentToken,
		"flush_every_turns": 1,
		"timeout_s":         30.0,
	}
}

// upsertRavenEntry writes:
//
//	memory.backend = "everme"              (select THE backend; single slot)
//	plugins.config.<id> = entry            (replace, preserving siblings)
//	plugins.disabled drops <id>            (a leftover opt-out would make
//	                                        the registry skip the plugin
//	                                        while install looks successful)
//
// Any path element that exists with a non-object type is left alone and
// the call returns an error — the user must fix the config manually
// instead of having us silently destroy whatever they had there.
func upsertRavenEntry(cfg map[string]interface{}, entry map[string]interface{}) error {
	memory, err := ensureObjectAt(cfg, "memory")
	if err != nil {
		return err
	}
	memory["backend"] = ravenBackendName

	plugins, err := ensureObjectAt(cfg, "plugins")
	if err != nil {
		return err
	}
	pluginCfg, err := ensureObjectAt(plugins, "config")
	if err != nil {
		return err
	}
	pluginCfg[RavenPluginID] = entry

	disabled, err := ensureStringSlice(plugins, "disabled")
	if err != nil {
		return err
	}
	if containsString(disabled, RavenPluginID) {
		kept := make([]interface{}, 0, len(disabled))
		for _, v := range disabled {
			if s, ok := v.(string); ok && s == RavenPluginID {
				continue
			}
			kept = append(kept, v)
		}
		plugins["disabled"] = kept
	}
	return nil
}

// Verify re-reads the on-disk JSON and asserts the backend mode is
// correctly installed: plugins/everme-memory/raven-plugin.toml exists
// and memory.backend=everme is set in config.json.
func (*ravenWriter) Verify(_ context.Context, result *WriteResult) error {
	if result == nil {
		return output.Internal(fmt.Errorf("nil result"))
	}
	home := filepath.Dir(result.ConfigPath)
	cfg, exists, err := readConfig(result.ConfigPath)
	if err != nil {
		return err
	}
	if !exists {
		return output.IOErr(result.ConfigPath, "verify", fmt.Errorf("config file missing after Commit"))
	}
	if !ravenBackendInstalled(home, cfg) {
		return output.IOErr(result.ConfigPath, "verify",
			fmt.Errorf("backend not installed: plugins/%s or memory.backend=%s missing", RavenPluginID, ravenBackendName))
	}
	return nil
}

// ---- helpers --------------------------------------------------------

// ravenBackendInstalled reports whether the EverMe backend is wired:
// the plugin manifest exists AND config.json selects
// memory.backend=everme.
func ravenBackendInstalled(home string, cfg map[string]interface{}) bool {
	if _, err := os.Stat(filepath.Join(home, "plugins", RavenPluginID, "raven-plugin.toml")); err != nil {
		return false
	}
	mem, ok := cfg["memory"].(map[string]interface{})
	if !ok {
		return false
	}
	backend, _ := mem["backend"].(string)
	return backend == ravenBackendName
}
