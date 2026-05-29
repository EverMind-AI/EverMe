// Package plugin — Codex support.
//
// Codex (both the App and the CLI) reads MCP servers, plugins, and
// marketplaces from a single TOML file at ~/.codex/config.toml. So
// `evercli plugin install codex` lands a unified `platform=codex`
// configuration that both consume — see B.0 / H.2 in
// docs/mcp-codex-hermes-iteration-plan-2026-05-26.md for why we
// deliberately don't split into codex-cli / codex-desktop.
//
// Wire model:
//
//	detector
//	  → Installed iff `codex` CLI is on PATH or ~/.codex/ exists.
//	  → HasEverMeEntry := config.toml has [mcp_servers.everme] with a non-empty token.
//
//	writer.Prepare        (runs BEFORE token mint — see Preparer interface)
//	  → `codex plugin marketplace add EverMind-AI/EverMe`
//	    so the marketplace is registered before we ask the backend for an evt.
//	    EverMind-AI/EverMe is a dedicated repo whose root IS the marketplace
//	    (manifest at .agents/plugins/marketplace.json), so we full-clone it —
//	    no --sparse (Codex treats the repo root as the marketplace root, and a
//	    sparse cone would exclude the root-level .agents/ manifest).
//	    If this fails (network, missing CLI), /agents is
//	    never called, no stranded token.
//
//	writer.Plan
//	  → snapshot ~/.codex/config.toml (mtime/size) for TOCTOU; parse TOML; verify
//	    the EverMe-owned sections can be upserted without colliding with a
//	    user-supplied non-table at the same path.
//
//	writer.Commit         (after backend mints a fresh evt)
//	  → upsert [plugins."everme@everme"], [mcp_servers.everme],
//	    [mcp_servers.everme.env]; preserve every other key in the file
//	    verbatim. [marketplaces.everme] is NOT touched — Codex CLI's
//	    marketplace add (in Prepare) owns that section.
//
//	writer.Verify
//	  → re-parse the written file, assert [marketplaces.everme] (written
//	    by Prepare), [plugins."everme@everme"] (Commit), and
//	    [mcp_servers.everme.env.EVERME_AGENT_TOKEN] non-empty (Commit) are
//	    all present. Does NOT compare the token value against what
//	    RegisterAgent returned — that defense is `evercli doctor`.
//
// Atomicity: TOML serialisation + .tmp + rename (writeFileAtomic, shared with
// the JSON writer). A crash between marshal and rename leaves the original file
// intact.
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
	"time"

	"github.com/pelletier/go-toml/v2"

	"evercli/internal/output"
)

// codexMarketplaceName / codexPluginSpec are the stable identifiers we
// claim in ~/.codex/config.toml. The plugin spec `everme@everme` is
// <plugin-name>@<marketplace-name> — Codex disambiguates plugins of the
// same name across marketplaces this way.
const (
	codexMarketplaceName = "everme"
	codexMcpEntryName    = "everme"
	codexPluginSpec      = "everme@everme"
	codexMarketplaceRepo = "EverMind-AI/EverMe"
)

// codexCommand resolves the `codex` CLI. EVERCLI_CODEX_CMD lets tests
// point at a stub so we don't shell out to the real CLI in unit tests.
// Same pattern as EVERCLI_CLAUDE_CMD.
func codexCommand() string {
	if v := os.Getenv("EVERCLI_CODEX_CMD"); v != "" {
		return v
	}
	return "codex"
}

// codexConfigPath returns ~/.codex/config.toml. EVERCLI_CODEX_CONFIG_DIR
// lets tests pin the parent dir without touching $HOME.
func codexConfigPath() (string, error) {
	if dir := os.Getenv("EVERCLI_CODEX_CONFIG_DIR"); dir != "" {
		return filepath.Join(dir, "config.toml"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", output.IOErr("codex", "resolve-home", err)
	}
	return filepath.Join(home, ".codex", "config.toml"), nil
}

// ---- detector ------------------------------------------------------

type codexDetector struct{}

func (codexDetector) Platform() Platform { return PlatformCodex }

func (codexDetector) DisplayName() string { return "Codex" }

func (codexDetector) Detect(_ context.Context) (*Detection, error) {
	path, err := codexConfigPath()
	if err != nil {
		return &Detection{Platform: PlatformCodex, DisplayName: "Codex"}, nil
	}
	d := &Detection{
		Platform:    PlatformCodex,
		DisplayName: "Codex",
		ConfigPath:  path,
	}

	// Installed requires the `codex` CLI on PATH — Prepare shells out
	// to `codex plugin marketplace add` before the backend mints a
	// token, so a Desktop-App-only install (config dir present, CLI
	// missing) is guaranteed to fail at Prepare. Reporting Installed=
	// true there would route the user into a doomed install. Detector
	// and Prepare therefore agree on a single CLI-on-PATH precondition;
	// a config-dir-only signal is treated as not-installed so the user
	// gets the actionable "install the codex CLI" hint instead.
	if _, err := exec.LookPath(codexCommand()); err == nil {
		d.Installed = true
	}

	cfg, exists, err := readCodexConfig(path)
	if err != nil {
		return d, err
	}
	d.ConfigExists = exists
	if exists {
		d.HasEverMeEntry = codexHasEverMeEntry(cfg)
	}
	return d, nil
}

// ---- writer --------------------------------------------------------

// codexWriter implements Writer + Preparer + Verifier. Verifier proves
// Commit's effects survived the round-trip (some Codex versions cache
// config and need a restart, but the on-disk shape is the load-bearing
// guarantee — Verify only checks the file, not the running app).
type codexWriter struct{}

func newCodexWriter() *codexWriter { return &codexWriter{} }

func (*codexWriter) Platform() Platform { return PlatformCodex }

// Prepare runs `codex plugin marketplace add EverMind-AI/EverMe`
// BEFORE the backend mints a token, but only when the marketplace
// section is NOT yet in ~/.codex/config.toml. This lets a token
// rotation work fully offline once the marketplace has been registered
// once on the box — the shellout is the only step in this writer that
// needs network.
//
// Codex's marketplace add is documented as idempotent, but each call
// re-fetches the repo from GitHub; skipping when already registered
// also avoids re-downloading the repo on every rotate.
//
// On failure we capture the CLI's stdout+stderr internally and surface
// only the trimmed tail in the hint, so structured-JSON callers don't
// get interleaved progress lines, and so a one-time device-auth URL
// printed by Codex doesn't land in a tee'd install.log.
func (w *codexWriter) Prepare(ctx context.Context, detection *Detection) error {
	if marketplaceAlreadyAdded(detection) {
		return nil
	}
	if _, err := exec.LookPath(codexCommand()); err != nil {
		ce := output.IOErr("codex", "lookup-cli", err)
		ce.Hint = "Install Codex (https://codex.openai.com/) and ensure the `codex` CLI is on PATH, then retry"
		return ce
	}
	cmd := exec.CommandContext(ctx,
		codexCommand(),
		"plugin", "marketplace", "add",
		codexMarketplaceRepo,
	)
	cmd.WaitDelay = 30 * time.Second
	var captured bytes.Buffer
	cmd.Stderr = &captured
	cmd.Stdout = &captured
	if err := cmd.Run(); err != nil {
		ce := output.IOErr("codex plugin marketplace add", "exec", err)
		ce.Hint = fmt.Sprintf(
			"Marketplace add failed. Check network reachability for github.com/%s and that the repo is reachable. To override, run the command manually and re-attempt `evercli plugin install codex`. Codex CLI output: %s",
			codexMarketplaceRepo, trimForHint(captured.String()))
		return ce
	}
	return nil
}

// marketplaceAlreadyAdded reports whether Prepare can skip the
// `codex plugin marketplace add` shellout because the same Codex
// machine already has the section registered. We re-parse the config
// rather than trusting detection.HasEverMeEntry (which only checks the
// mcp_server token) so the answer reflects the marketplace state
// specifically.
func marketplaceAlreadyAdded(detection *Detection) bool {
	if detection == nil || detection.ConfigPath == "" {
		return false
	}
	cfg, exists, err := readCodexConfig(detection.ConfigPath)
	if err != nil || !exists {
		return false
	}
	return codexHasMarketplace(cfg)
}

// trimForHint truncates captured subprocess output to a single-line
// rightmost tail suitable for embedding in an error hint. Strips
// trailing whitespace, collapses internal newlines to "; ", and caps
// at 200 chars — keeps the hint readable in `--format text` and JSON
// without dumping the entire codex CLI transcript.
func trimForHint(s string) string {
	s = strings.TrimSpace(s)
	s = strings.ReplaceAll(s, "\n", "; ")
	const maxLen = 200
	if len(s) > maxLen {
		s = "…" + s[len(s)-maxLen:]
	}
	if s == "" {
		return "(no output)"
	}
	return s
}

// Plan reads ~/.codex/config.toml to decide WillReplace + BackupPath,
// but deliberately leaves SnapshotModTime/SnapshotSize at zero so the
// file-level TOCTOU check in assertNoConcurrentChange is a no-op for
// Codex. Reason: Codex App and Codex CLI both update other sections
// of this file in the background (e.g. `[desktop]` settings, the
// `last_updated` timestamp inside `[marketplaces.everme]`). A
// mtime-based snapshot would false-fail on every install where the
// user has Codex App running. The atomic write + structured merge in
// upsertCodexEntries preserves every non-EverMe-owned key by
// construction, so racing benign writers cannot lose user data; the
// last-writer-wins semantic on the EverMe-owned subtree is acceptable
// because the only writer we ourselves race against is another
// evercli run, which would converge on the same final state via the
// /agents upsert. Returns an error rather than overwriting if the
// existing file is malformed TOML — we'd rather have the user fix it
// manually than silently destroy data.
func (*codexWriter) Plan(_ context.Context, configPath string) (*WritePlan, error) {
	if configPath == "" {
		return nil, output.Invalid("configPath is required", "")
	}
	abs, err := filepath.Abs(configPath)
	if err != nil {
		return nil, output.IOErr(configPath, "abs-path", err)
	}

	plan := &WritePlan{Platform: PlatformCodex, ConfigPath: abs}

	parent := filepath.Dir(abs)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return nil, output.IOErr(parent, "mkdir-parent", err)
	}

	cfg, exists, err := readCodexConfig(abs)
	if err != nil {
		return nil, err
	}
	plan.WillCreate = !exists
	plan.WillReplace = codexHasEverMeEntry(cfg)
	if exists {
		plan.BackupPath = abs + backupSuffix
		// Snapshot fields stay zero — see the file-level comment on
		// Plan() for why mtime-based TOCTOU is disabled for Codex.
		// The WillCreate concurrent-create branch is still active so
		// a race between two evercli runs against an absent file is
		// still rejected; only the post-Plan benign writes by Codex
		// itself are tolerated.
	}

	plan.PreviewEntry = map[string]interface{}{
		"marketplace": codexMarketplaceName,
		"plugin":      codexPluginSpec,
		"mcpServer":   codexMcpEntryName,
		"agentId":     "agt_<assigned-on-commit>",
		"agentToken":  "evt_<assigned-on-commit>",
	}
	return plan, nil
}

// Commit upserts the EverMe-owned plugin + MCP-server sections in
// ~/.codex/config.toml: [plugins."everme@everme"] and
// [mcp_servers.everme] (with its nested [mcp_servers.everme.env]).
// [marketplaces.everme] is intentionally NOT written here — Codex CLI's
// `marketplace add` (executed by Prepare) owns that section, and
// overwriting it would clobber Codex's own last_updated timestamp and
// the source_type it resolved. Every other key in the file is preserved
// verbatim — we go through go-toml's generic map[string]any parse
// rather than a strongly-typed struct precisely so unknown keys (other
// marketplaces, other MCP servers, Codex-internal [desktop] settings)
// round-trip unchanged.
func (*codexWriter) Commit(_ context.Context, plan *WritePlan, params WriteParams) (*WriteResult, error) {
	if plan == nil {
		return nil, output.Internal(fmt.Errorf("nil plan"))
	}
	if err := assertNoConcurrentChange(plan); err != nil {
		return nil, err
	}

	cfg, exists, err := readCodexConfig(plan.ConfigPath)
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
	if err := upsertCodexEntries(cfg, params); err != nil {
		return nil, output.Invalid(
			fmt.Sprintf("config at %s has a shape collision: %v", plan.ConfigPath, err),
			"Fix the config file's shape manually (one of marketplaces.*, plugins.*, mcp_servers.* exists with an unexpected non-table value), then retry install",
		)
	}

	if err := writeCodexConfig(plan.ConfigPath, cfg); err != nil {
		return nil, err
	}

	return &WriteResult{
		Platform:      PlatformCodex,
		ConfigPath:    plan.ConfigPath,
		BackupPath:    wroteBackup,
		WroteNewEntry: !plan.WillReplace,
	}, nil
}

// Verify re-reads the on-disk config and asserts the three sections
// the install workflow depends on are present:
//   - `[marketplaces.everme]` (written by Codex CLI in Prepare)
//   - `[plugins."everme@everme"] enabled = true` (written by Commit)
//   - `[mcp_servers.everme]` with a non-empty EVERME_AGENT_TOKEN
//     (written by Commit)
//
// This catches TOML round-trip bugs (e.g. a missing quote on a key
// with a dot) and silent path collisions where upsert "succeeded" but
// landed at the wrong nesting level. It does NOT verify the token
// value matches what RegisterAgent returned — WriteResult intentionally
// does not carry the plaintext token, and a stale-but-non-empty token
// at the canonical path will pass this check. The trade-off is
// deliberate: tighter validation would require leaking the token shape
// further through the lifecycle, and `evercli doctor` runs the runtime
// auth probe that catches stale tokens.
//
// It also does NOT probe the running Codex app — Codex caches config
// in memory and may need a restart to pick up changes. We only validate
// the file shape, which is the contract we own.
func (*codexWriter) Verify(_ context.Context, result *WriteResult) error {
	if result == nil {
		return output.Internal(fmt.Errorf("nil result"))
	}
	cfg, exists, err := readCodexConfig(result.ConfigPath)
	if err != nil {
		return err
	}
	if !exists {
		return output.IOErr(result.ConfigPath, "verify", fmt.Errorf("config file is missing after Commit"))
	}
	if !codexHasMarketplace(cfg) {
		return output.IOErr(result.ConfigPath, "verify", fmt.Errorf("marketplaces.%s missing", codexMarketplaceName))
	}
	if !codexHasPluginEnabled(cfg) {
		return output.IOErr(result.ConfigPath, "verify", fmt.Errorf("plugins.%q missing or not enabled", codexPluginSpec))
	}
	if !codexHasEverMeEntry(cfg) {
		return output.IOErr(result.ConfigPath, "verify", fmt.Errorf("mcp_servers.%s missing or empty", codexMcpEntryName))
	}
	return nil
}

// ---- helpers --------------------------------------------------------

// readCodexConfig parses the TOML config at path. Returns (cfg, exists, err).
// Missing file → (nil, false, nil); malformed TOML → IO error so the
// user knows to fix it manually rather than have us silently overwrite.
func readCodexConfig(path string) (map[string]interface{}, bool, error) {
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
	if err := toml.Unmarshal(raw, &cfg); err != nil {
		ce := output.IOErr(path, "parse-toml", err)
		ce.Hint = "Config is not valid TOML; fix it manually before re-running"
		return nil, true, ce
	}
	return cfg, true, nil
}

// writeCodexConfig serialises cfg as TOML and atomically replaces path.
// Mode is forced to 0600 — matches the JSON writer; the file holds a
// freshly minted token, so a pre-existing 0644 must be tightened rather
// than inherited.
func writeCodexConfig(path string, cfg map[string]interface{}) error {
	raw, err := toml.Marshal(cfg)
	if err != nil {
		return output.Internal(fmt.Errorf("marshal config: %w", err))
	}
	if err := writeFileAtomic(path, raw, 0o600); err != nil {
		return output.IOErr(path, "write-config", err)
	}
	return nil
}

// upsertCodexEntries replaces the EverMe-owned plugin + mcp_server
// sections of cfg with fresh values, preserving every other key
// untouched. Notably it does NOT write [marketplaces.everme] — the
// `codex plugin marketplace add` CLI invocation in Prepare already
// writes that section with whatever source-type it resolved (local /
// github). Re-writing it here would overwrite Codex's own
// last_updated timestamp and risk encoding the wrong source_type when
// the user installed from a non-github mirror.
//
// Any path element that exists with a non-table value (e.g. user wrote
// `plugins = "off"` as a string) returns an error rather than silently
// destroying it.
func upsertCodexEntries(cfg map[string]interface{}, params WriteParams) error {
	plugins, err := ensureObjectAt(cfg, "plugins")
	if err != nil {
		return err
	}
	plugins[codexPluginSpec] = map[string]interface{}{"enabled": true}

	mcpServers, err := ensureObjectAt(cfg, "mcp_servers")
	if err != nil {
		return err
	}
	// npxCommand() flips to "npx.cmd" on Windows — Codex on Windows
	// can't resolve a bare "npx" because the spawn path doesn't apply
	// PATHEXT. Same constraint as the JSON writer's buildEntry().
	mcpServers[codexMcpEntryName] = map[string]interface{}{
		"command": npxCommand(),
		"args":    []interface{}{"-y", "@everme/memory-mcp"},
		"env": map[string]interface{}{
			"EVERME_API_BASE":    params.APIBaseURL,
			"EVERME_AGENT_ID":    params.AgentID,
			"EVERME_AGENT_TOKEN": params.AgentToken,
		},
	}
	return nil
}

// codexHasEverMeEntry checks that mcp_servers.everme exists and carries
// a non-empty env.EVERME_AGENT_TOKEN. We don't validate the token's
// shape (evt_ prefix, length) — the live token check belongs to the
// runtime, not the installer's detector.
func codexHasEverMeEntry(cfg map[string]interface{}) bool {
	mcpServers, _ := cfg["mcp_servers"].(map[string]interface{})
	if mcpServers == nil {
		return false
	}
	entry, _ := mcpServers[codexMcpEntryName].(map[string]interface{})
	if entry == nil {
		return false
	}
	env, _ := entry["env"].(map[string]interface{})
	if env == nil {
		return false
	}
	tok, _ := env["EVERME_AGENT_TOKEN"].(string)
	return tok != ""
}

func codexHasMarketplace(cfg map[string]interface{}) bool {
	marketplaces, _ := cfg["marketplaces"].(map[string]interface{})
	if marketplaces == nil {
		return false
	}
	_, ok := marketplaces[codexMarketplaceName].(map[string]interface{})
	return ok
}

func codexHasPluginEnabled(cfg map[string]interface{}) bool {
	plugins, _ := cfg["plugins"].(map[string]interface{})
	if plugins == nil {
		return false
	}
	entry, _ := plugins[codexPluginSpec].(map[string]interface{})
	if entry == nil {
		return false
	}
	enabled, _ := entry["enabled"].(bool)
	return enabled
}
