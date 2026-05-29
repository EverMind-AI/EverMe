// Package plugin — Hermes support.
//
// Hermes (NousResearch/hermes-agent, Python) reads MCP servers from
// `mcp_servers.<name>` in ~/.hermes/config.yaml. We upsert the
// `everme` entry there directly via yaml.v3, mirroring exactly what
// Hermes's own `_save_mcp_server(name, dict)` catalog-install helper
// does in hermes_cli/mcp_config.py — same on-disk shape, same effect.
//
// Why not shell out to `hermes mcp add`:
//
//	The CLI's `--args` / `--env` flags are argparse nargs="*". When the
//	value list contains a dash-leading element (we need `-y` for
//	`npx -y @everme/memory-mcp`), argparse rejects it as an unknown
//	option — confirmed against Hermes v0.14.0 / hermes_cli/main.py
//	mcp_add_p. Repeating `--args=-y --args=@everme/memory-mcp` doesn't
//	help either: the second `--args` clobbers the first. Catalog
//	manifests dodge this by writing the dict straight into the YAML
//	(see optional-mcps/n8n/manifest.yaml's `transport.args: [...]`
//	pipeline through `_save_mcp_server`), and every third-party
//	hermes MCP plugin we surveyed (e.g. hermes-n8n-mcp) tells users
//	to paste a `mcp_servers:` YAML block into config.yaml by hand.
//	evercli automates that paste.
//
// Entry name is `everme` (not `everme-memory` like Cursor / Claude
// Desktop / Claude Code), because Hermes prefixes MCP tools as
// `mcp_<server>_<tool>` and `mcp_everme_mem_context` reads cleaner
// than `mcp_everme-memory_mem_context` in tool catalogs and prompts.
//
// Wire model:
//
//	detector
//	  → Installed iff `hermes` CLI is on PATH or ~/.hermes/ exists.
//	  → HasEverMeEntry := config.yaml has mcp_servers.everme with a non-empty map.
//
//	writer.Plan
//	  → snapshot ~/.hermes/config.yaml (mtime/size) for TOCTOU; parse YAML;
//	    decide WillCreate / WillReplace.
//
//	writer.Commit (after backend mints a fresh evt)
//	  → upsert mcp_servers.everme = {command, args, env{API_BASE, AGENT_ID, AGENT_TOKEN}};
//	    every other top-level key (agent, memory, model, …) and every
//	    sibling mcp_servers entry round-trips verbatim.
//
//	writer.Verify
//	  → re-read the file, assert mcp_servers.everme is present and non-empty.
//
// Trade-off — comment loss:
//
//	yaml.v3 unmarshal into map[string]any loses comments and source-order.
//	Hermes regenerates its commented config on `hermes config migrate`
//	if a user complains. The load-bearing contract we own is the entry
//	shape; cosmetic round-trip is V1.1's problem if it surfaces.
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
	"strings"

	"gopkg.in/yaml.v3"

	"evercli/internal/output"
)

// hermesMcpEntryName is the key under `mcp_servers` that EverMe owns
// in ~/.hermes/config.yaml. See the file-level comment for why this
// is `everme` and not `everme-memory`.
const hermesMcpEntryName = "everme"

// hermesCommand resolves the `hermes` CLI. EVERCLI_HERMES_CMD lets tests
// point at a stub so we don't shell out (or PATH-probe) the real CLI.
// Same pattern as EVERCLI_CODEX_CMD.
func hermesCommand() string {
	if v := os.Getenv("EVERCLI_HERMES_CMD"); v != "" {
		return v
	}
	return "hermes"
}

// hermesHome resolves the Hermes home directory using the priority chain
// mandated by Hermes maintainers (docs/mcp-codex-hermes-iteration-plan-
// 2026-05-26.md §C.4): installer code MUST NOT hard-guess `~/.hermes`
// when a user has overridden the location. Order:
//
//  1. EVERCLI_HERMES_CONFIG_DIR  — test / advanced override; if set,
//     wins outright. Same env var the Detector / Writer use to pin
//     the config dir in unit tests.
//  2. HERMES_HOME  — Hermes's own well-known env var; multi-instance
//     setups (dev / prod) use this to keep separate config trees.
//  3. `hermes config path` — authoritative source of truth from the
//     installed Hermes CLI itself; works on any user who has Hermes
//     on PATH, regardless of how they configured home. Returns the
//     full config.yaml path; we strip the basename to recover home.
//  4. `$HOME/.hermes` — last-resort fallback only when none of the
//     above resolve (no env override, no CLI on PATH). Matches what
//     a fresh Hermes install does.
//
// Returns (home, err) where err is non-nil only on a genuine OS
// failure (e.g. user has no $HOME) — the three preceding steps all
// degrade gracefully so the fallback fires when no signal is present.
func hermesHome() (string, error) {
	if v := os.Getenv("EVERCLI_HERMES_CONFIG_DIR"); v != "" {
		return v, nil
	}
	if v := os.Getenv("HERMES_HOME"); v != "" {
		return v, nil
	}
	if p, ok := probeHermesConfigPathCLI(); ok {
		// `hermes config path` prints the config.yaml absolute path; we
		// want the parent directory.
		return filepath.Dir(p), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", output.IOErr("hermes", "resolve-home", err)
	}
	return filepath.Join(home, ".hermes"), nil
}

// probeHermesConfigPathCLI runs `hermes config path` and returns the
// trimmed stdout when it succeeds (one absolute file path per Hermes
// v0.14+ contract). Best-effort: any failure — CLI not on PATH,
// non-zero exit, garbage output — returns ("", false) so the caller
// falls through to the next priority level. We intentionally do NOT
// surface the exec error: Hermes may not be installed yet (Detector
// path) or the user may have explicitly broken it, and the fallback
// is correct in both cases.
func probeHermesConfigPathCLI() (string, bool) {
	cmd := exec.Command(hermesCommand(), "config", "path")
	out, err := cmd.Output()
	if err != nil {
		return "", false
	}
	p := strings.TrimSpace(string(out))
	if p == "" || !filepath.IsAbs(p) {
		return "", false
	}
	return p, true
}

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
	if exists {
		d.HasEverMeEntry = hermesHasEverMeEntry(cfg)
	}
	return d, nil
}

// ---- writer --------------------------------------------------------

// hermesWriter implements Writer + Verifier. It does NOT implement
// Preparer: unlike Codex's marketplace step, Hermes has no out-of-band
// registration phase — `mcp_servers.everme` IS the install, and it
// lands atomically in Commit.
type hermesWriter struct{}

func newHermesWriter() *hermesWriter { return &hermesWriter{} }

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
	plan.WillReplace = hermesHasEverMeEntry(cfg)
	if exists {
		plan.BackupPath = abs + backupSuffix
		if info, statErr := os.Stat(abs); statErr == nil {
			plan.SnapshotModTime = info.ModTime().UnixNano()
			plan.SnapshotSize = info.Size()
		}
	}

	plan.PreviewEntry = buildEntry(
		"https://api.everme.evermind.ai",
		"agt_<assigned-on-commit>",
		"evt_<assigned-on-commit>",
	)
	return plan, nil
}

// Commit upserts mcp_servers.everme, preserving every other key in
// the file. The atomic write goes through writeFileAtomic (shared
// with the JSON / TOML writers) so a crash between marshal and rename
// leaves the original file intact.
func (*hermesWriter) Commit(_ context.Context, plan *WritePlan, params WriteParams) (*WriteResult, error) {
	if plan == nil {
		return nil, output.Internal(fmt.Errorf("nil plan"))
	}
	if err := assertNoConcurrentChange(plan); err != nil {
		return nil, err
	}

	cfg, exists, err := readHermesConfig(plan.ConfigPath)
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
	if err := upsertHermesEntry(cfg, params); err != nil {
		return nil, output.Invalid(
			fmt.Sprintf("config at %s has a shape collision under mcp_servers: %v", plan.ConfigPath, err),
			"Fix the config file's shape manually (mcp_servers exists with a non-object value), then retry install",
		)
	}

	if err := writeHermesConfig(plan.ConfigPath, cfg); err != nil {
		return nil, err
	}

	return &WriteResult{
		Platform:      PlatformHermes,
		ConfigPath:    plan.ConfigPath,
		BackupPath:    wroteBackup,
		WroteNewEntry: !plan.WillReplace,
	}, nil
}

// Verify re-reads the on-disk YAML and asserts mcp_servers.everme is
// present and non-empty. Mirrors codexWriter.Verify in catching
// round-trip serialisation bugs without leaking the token value
// through WriteResult.
//
// It does NOT probe the running Hermes process — Hermes caches MCP
// config and may need a `hermes mcp test everme` or fresh session to
// pick up the change. We only validate the file shape, which is the
// contract we own.
func (*hermesWriter) Verify(_ context.Context, result *WriteResult) error {
	if result == nil {
		return output.Internal(fmt.Errorf("nil result"))
	}
	cfg, exists, err := readHermesConfig(result.ConfigPath)
	if err != nil {
		return err
	}
	if !exists {
		return output.IOErr(result.ConfigPath, "verify", fmt.Errorf("config file is missing after Commit"))
	}
	if !hermesHasEverMeEntry(cfg) {
		return output.IOErr(result.ConfigPath, "verify", fmt.Errorf("mcp_servers.%s missing or empty", hermesMcpEntryName))
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
// path. Mode inheritance: existing files keep their mode (Hermes writes
// 0600), fresh files land 0600 because they carry a token.
func writeHermesConfig(path string, cfg map[string]interface{}) error {
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

	mode := os.FileMode(0o600)
	if info, err := os.Stat(path); err == nil {
		mode = info.Mode().Perm()
	}
	if err := writeFileAtomic(path, buf.Bytes(), mode); err != nil {
		return output.IOErr(path, "write-config", err)
	}
	return nil
}

// hermesHasEverMeEntry reports whether mcp_servers.everme exists with
// a non-empty EVERME_AGENT_TOKEN in its env map. Mirrors
// codexHasEverMeEntry — a bare scaffold (entry present but no token,
// or no env at all) is treated as "not yet configured" so the
// detector tells the cmd layer to (re)install rather than skip. The
// token presence check catches three otherwise-silent failure modes
// at detection time:
//
//   - Hand-written stubs (user pasted a yaml block from a README but
//     forgot the credentials section).
//   - Stale entries left after backend agent disconnect (token would
//     no longer auth, but the entry shape is intact).
//   - Partial installs from an earlier evercli crash between yaml
//     write and backend mint.
//
// "Non-empty token" is the same contract codex.go enforces and is
// sufficient for install/skip routing; it does NOT validate the
// token is still alive on the backend — that's `evercli doctor`'s job.
func hermesHasEverMeEntry(cfg map[string]interface{}) bool {
	if cfg == nil {
		return false
	}
	servers, ok := cfg["mcp_servers"].(map[string]interface{})
	if !ok {
		return false
	}
	entry, ok := servers[hermesMcpEntryName].(map[string]interface{})
	if !ok {
		return false
	}
	env, ok := entry["env"].(map[string]interface{})
	if !ok {
		return false
	}
	tok, _ := env["EVERME_AGENT_TOKEN"].(string)
	return tok != ""
}

// upsertHermesEntry sets cfg.mcp_servers.everme = buildEntry(...),
// preserving every other key in cfg and every other key under
// mcp_servers. Returns an error if mcp_servers exists with a non-map
// type (refuse to silently destroy user data — see the same rationale
// in mcp.go's ensureServersMap).
func upsertHermesEntry(cfg map[string]interface{}, params WriteParams) error {
	var servers map[string]interface{}
	if raw, present := cfg["mcp_servers"]; present && raw != nil {
		m, ok := raw.(map[string]interface{})
		if !ok {
			return fmt.Errorf(
				"mcp_servers has type %T; expected an object — refuse to overwrite, please fix the config manually",
				raw)
		}
		servers = m
	} else {
		servers = map[string]interface{}{}
	}
	cfg["mcp_servers"] = servers
	servers[hermesMcpEntryName] = buildEntry(params.APIBaseURL, params.AgentID, params.AgentToken)
	return nil
}
