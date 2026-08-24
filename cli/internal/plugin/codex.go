// Package plugin — Codex support.
//
// Codex (both the App and the CLI) reads MCP servers, plugins, and
// marketplaces from a single TOML file at ~/.codex/config.toml. So
// `evercli plugin install codex` lands a unified `platform=codex`
// configuration that both consume — we deliberately don't split into
// codex-cli / codex-desktop.
//
// Wire model:
//
//	detector
//	  → Installed iff `codex` is on PATH or a supported desktop app bundle
//	    contains the Codex management binary.
//	  → HasEverMeEntry := config.toml has [mcp_servers.everme] with a non-empty token.
//
//	writer.Prepare        (runs BEFORE token mint — see Preparer interface)
//	  → assert a Node >= codexHookNodeMinMajor runtime is on PATH. The Hook
//	    manifest spawns the bundled runner with a bare `node`, so without it
//	    the install would look healthy and every Hook would fail at spawn.
//	  → register or upgrade the EverMe marketplace, then run
//	    `codex plugin add everme@everme --json` and validate installedPath.
//	    EverMind-AI/EverMe is a dedicated repo whose root IS the marketplace
//	    (manifest at .agents/plugins/marketplace.json), so we full-clone it —
//	    no --sparse (Codex treats the repo root as the marketplace root, and a
//	    sparse cone would exclude the root-level .agents/ manifest).
//	    If this fails (network, missing Codex binary), /agents is
//	    never called, no stranded token.
//	  → best-effort: speak the app-server RPC protocol (codex_apprpc.go,
//	    codex_hook_trust.go) to trust the four EverMe lifecycle hooks Codex
//	    otherwise leaves in "pending trust" until a human runs `/hooks`
//	    inside a session. Never fatal — deferred to Verify as a warning, same
//	    as the marketplace-upgrade and plugin-install failures below, since
//	    older Codex CLI releases may not implement these RPCs at all.
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
//	    RegisterAgent returned — that defense is `evercli doctor`. Also
//	    surfaces any deferred Prepare-time warning (plugin-cache refresh,
//	    marketplace upgrade, hook trust) once the on-disk checks pass.
//
// Atomicity: TOML serialisation + .tmp + rename (writeFileAtomic, shared with
// the JSON writer). A crash between marshal and rename leaves the original file
// intact.
package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
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

// codexHookNodeMinMajor is the oldest Node major the bundled Hook runner is
// built for (esbuild target node18, mirrored by @everme/codex's engines field).
const codexHookNodeMinMajor = 18

// resolveNodeExecutable finds the Node runtime the marketplace Hook manifest
// depends on. The manifest spawns the bundled runner with a bare `node`, so a
// runtime that exists on disk but not on PATH does not satisfy the requirement.
func resolveNodeExecutable() (string, error) {
	if override := os.Getenv("EVERCLI_NODE_CMD"); override != "" {
		return exec.LookPath(override)
	}
	return exec.LookPath("node")
}

// assertCodexHookRuntime refuses to install onto a machine whose lifecycle
// Hooks could not run. Without it the install still "succeeds" — token minted,
// config written, cache populated — and then every Hook dies at spawn time,
// which reads to the user as an EverMe outage rather than a missing
// dependency. Prepare calls it before any marketplace or backend side effect,
// so a rejected machine is left exactly as it was.
func assertCodexHookRuntime(ctx context.Context) error {
	node, err := resolveNodeExecutable()
	if err != nil {
		ce := output.IOErr("node", "lookup-hook-runtime", err)
		ce.Hint = fmt.Sprintf(
			"Codex lifecycle Hooks run the bundled runner with `node`, so Node %d or newer must be resolvable on PATH. Install it from nodejs.org or your package manager, then re-run `evercli plugin install codex`. The MCP server has the same requirement (it starts through `npx`)",
			codexHookNodeMinMajor)
		return ce
	}
	major, err := nodeMajorVersion(ctx, node)
	if err != nil {
		ce := output.IOErr(node, "probe-hook-runtime", err)
		ce.Hint = "`node -v` did not report a usable version. Repair the Node installation, or point evercli at a different one with EVERCLI_NODE_CMD, then retry"
		return ce
	}
	if major < codexHookNodeMinMajor {
		return output.Invalid(
			fmt.Sprintf("node at %s reports major version %d, but the Codex Hook runner requires Node %d or newer", node, major, codexHookNodeMinMajor),
			fmt.Sprintf("Upgrade Node to %d or newer, then re-run `evercli plugin install codex`", codexHookNodeMinMajor),
		)
	}
	return nil
}

// nodeMajorVersion parses the major version out of `node -v` (e.g. "v22.11.0").
func nodeMajorVersion(ctx context.Context, node string) (int, error) {
	cmd := exec.CommandContext(ctx, node, "-v")
	cmd.WaitDelay = 10 * time.Second
	out, err := cmd.Output()
	if err != nil {
		return 0, err
	}
	raw := strings.TrimSpace(string(out))
	major, _, _ := strings.Cut(strings.TrimPrefix(raw, "v"), ".")
	parsed, convErr := strconv.Atoi(major)
	if convErr != nil {
		return 0, fmt.Errorf("unexpected `node -v` output %q", raw)
	}
	return parsed, nil
}

// resolveCodexExecutable finds the Codex binary used to manage marketplaces
// and plugins. A standalone CLI on PATH remains preferred, while macOS users
// with only the desktop app installed can fall back to its bundled binary.
func resolveCodexExecutable() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	return resolveCodexExecutableFromCandidates(runtime.GOOS, codexAppBundleCandidates(home))
}

func resolveCodexExecutableFromCandidates(goos string, appCandidates []string) (string, error) {
	if override := os.Getenv("EVERCLI_CODEX_CMD"); override != "" {
		return exec.LookPath(override)
	}

	path, lookupErr := exec.LookPath("codex")
	if lookupErr == nil {
		return path, nil
	}
	if goos != "darwin" {
		return "", lookupErr
	}

	for _, candidate := range appCandidates {
		info, statErr := os.Stat(candidate)
		if statErr != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
			continue
		}
		return candidate, nil
	}
	return "", lookupErr
}

func codexAppBundleCandidates(home string) []string {
	const bundledBinary = "Contents/Resources/codex"
	candidates := []string{
		filepath.Join("/Applications", "ChatGPT.app", bundledBinary),
		filepath.Join("/Applications", "Codex.app", bundledBinary),
	}
	if home != "" {
		candidates = append(candidates,
			filepath.Join(home, "Applications", "ChatGPT.app", bundledBinary),
			filepath.Join(home, "Applications", "Codex.app", bundledBinary),
		)
	}
	return candidates
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

	// Prepare shells out to Codex before the backend mints a token. Accept a
	// standalone CLI or the binary bundled with the macOS desktop app, but do
	// not treat a config-directory-only signal as installed.
	if _, err := resolveCodexExecutable(); err == nil {
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
type codexWriter struct {
	// upgradeErr defers a failed best-effort `marketplace upgrade` from
	// Prepare to Verify, where it surfaces as an install warning rather
	// than a FailedEntry — the token is rotated and on disk either way.
	upgradeErr error
	// pluginInstallErr records a failed plugin refresh when an already-valid
	// cache lets token rotation continue offline. Verify surfaces it as a
	// warning after confirming the on-disk installation is usable.
	pluginInstallErr error
	// trustErr defers a failed best-effort app-server hook-trust attempt
	// from Prepare to Verify, same precedent as upgradeErr/pluginInstallErr
	// above: an older Codex CLI lacking the hooks/list/config/batchWrite
	// app-server RPCs must not block token rotation — the existing manual
	// "/hooks, review and trust" NextSteps instruction remains the fallback
	// (see Commit).
	trustErr error
	// installedPath comes from `codex plugin add --json` and is the source of
	// truth for post-install verification. Direct Verify unit tests leave it
	// empty and exercise the legacy cache-discovery fallback.
	installedPath string
}

func newCodexWriter() *codexWriter { return &codexWriter{} }

// Remove deletes only EverMe-owned Codex state. Codex keeps plugins and MCP
// servers in one TOML file, so sibling entries and marketplace metadata must
// survive. The env sidecar is owned by evercli and is removed as well.
func (*codexWriter) Remove(_ context.Context, configPath string) (*RemoveResult, error) {
	abs, err := filepath.Abs(configPath)
	if err != nil {
		return nil, output.IOErr(configPath, "abs-path", err)
	}
	cfg, exists, err := readCodexConfig(abs)
	if err != nil {
		return nil, err
	}
	result := &RemoveResult{Platform: PlatformCodex, ConfigPath: abs}
	removed := false
	if exists {
		if plugins, ok := cfg["plugins"].(map[string]interface{}); ok {
			if _, ok := plugins[codexPluginSpec]; ok {
				delete(plugins, codexPluginSpec)
				removed = true
			}
		}
		if servers, ok := cfg["mcp_servers"].(map[string]interface{}); ok {
			if _, ok := servers[codexMcpEntryName]; ok {
				delete(servers, codexMcpEntryName)
				removed = true
			}
		}
		if marketplaces, ok := cfg["marketplaces"].(map[string]interface{}); ok {
			if _, ok := marketplaces["everme"]; ok {
				delete(marketplaces, "everme")
				removed = true
			}
		}
	}
	envPath := filepath.Join(filepath.Dir(abs), "everme.env")
	if _, statErr := os.Stat(envPath); statErr == nil {
		removed = true
	}
	if !removed {
		return result, nil
	}
	if exists {
		// protected=true: config.toml carries the live agent token.
		backup, berr := backupFile(abs, true)
		if berr != nil {
			return nil, berr
		}
		// Our token is gone from cfg by now, so leave the host's mode alone.
		if err := writeCodexConfig(abs, cfg, configHasNoToken); err != nil {
			return nil, err
		}
		result.BackupPath = backup
	}
	if err := os.Remove(envPath); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, output.IOErr(envPath, "remove-env", err)
	}
	result.Removed = true
	return result, nil
}

func (*codexWriter) Platform() Platform { return PlatformCodex }

// Prepare registers or refreshes the marketplace BEFORE the backend
// mints a token — the shellout is the only step in this writer that
// needs network:
//
//   - marketplace not yet in ~/.codex/config.toml → `codex plugin
//     marketplace add EverMind-AI/EverMe`. A failure here is fatal:
//     without the marketplace nothing else can work.
//   - already registered → best-effort `codex plugin marketplace
//     upgrade everme`, so a box that registered once still picks up
//     newer plugin content (Codex only refreshes its cache when the
//     manifest version changes AND an upgrade runs). A failure here is
//     deferred to Verify as a warning: token rotation must keep
//     working fully offline.
//
// On failure we capture the CLI's stdout+stderr internally and surface
// only the trimmed tail in the hint, so structured-JSON callers don't
// get interleaved progress lines, and so a one-time device-auth URL
// printed by Codex doesn't land in a tee'd install.log.
func (w *codexWriter) Prepare(ctx context.Context, detection *Detection) error {
	codexExecutable, err := resolveCodexExecutable()
	if err != nil {
		ce := output.IOErr("codex", "lookup-cli", err)
		ce.Hint = "Install the Codex desktop app or CLI, then retry. On macOS, evercli automatically uses the binary bundled with ChatGPT.app or Codex.app"
		return ce
	}

	if err := assertCodexHookRuntime(ctx); err != nil {
		return err
	}

	if marketplaceAlreadyAdded(detection) {
		w.upgradeErr = upgradeCodexMarketplace(ctx)
	} else {
		cmd := exec.CommandContext(ctx,
			codexExecutable,
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
	}

	installedPath, installErr := installCodexPlugin(ctx, codexExecutable)
	if installErr == nil {
		w.installedPath = installedPath
	} else if detection != nil && detection.ConfigPath != "" {
		// A healthy existing cache keeps token rotation available when the
		// marketplace cannot be refreshed offline. Fresh installs still fail before
		// the backend mints a token because there is no usable plugin to fall back to.
		if existingPath, findErr := findCodexInstalledPath(detection.ConfigPath); findErr == nil {
			w.installedPath = existingPath
			w.pluginInstallErr = installErr
		}
	}
	if w.installedPath == "" {
		return installErr
	}

	// Best-effort: establish app-server "hook trust" for the four lifecycle
	// hooks the plugin ships, so they actually run instead of sitting in
	// Codex's pending-trust state until a human opens `/hooks`. Runs on the
	// same codexExecutable already resolved above; depends only on
	// hooks.json already being on disk, which a non-empty w.installedPath
	// guarantees. Never fatal — see trustErr's field comment.
	w.trustErr = codexEstablishHookTrust(ctx, codexExecutable)
	return nil
}

type codexPluginInstallResult struct {
	InstalledPath string `json:"installedPath"`
}

func installCodexPlugin(ctx context.Context, codexExecutable string) (string, error) {
	cmd := exec.CommandContext(ctx,
		codexExecutable,
		"plugin", "add", codexPluginSpec, "--json",
	)
	cmd.WaitDelay = 30 * time.Second
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		ce := output.IOErr("codex plugin add", "exec", err)
		ce.Hint = "The EverMe marketplace is configured but the plugin cache could not be installed. Codex CLI output: " + trimForHint(stderr.String())
		return "", ce
	}

	var result codexPluginInstallResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		ce := output.IOErr("codex plugin add", "parse-json", err)
		ce.Hint = "Codex returned an unexpected plugin installation response: " + trimForHint(stdout.String())
		return "", ce
	}
	if strings.TrimSpace(result.InstalledPath) == "" {
		return "", output.IOErr("codex plugin add", "verify", fmt.Errorf("installedPath missing from Codex response"))
	}
	abs, err := filepath.Abs(result.InstalledPath)
	if err != nil {
		return "", output.IOErr(result.InstalledPath, "abs-path", err)
	}
	if err := validateCodexInstalledPath(abs); err != nil {
		return "", output.IOErr(abs, "verify-plugin", err)
	}
	return abs, nil
}

// upgradeCodexMarketplace runs `codex plugin marketplace upgrade
// everme` and returns a classified error on failure. Callers treat the
// result as advisory (see Prepare) — never abort an install on it.
func upgradeCodexMarketplace(ctx context.Context) error {
	codexExecutable, err := resolveCodexExecutable()
	if err != nil {
		ce := output.IOErr("codex", "lookup-cli", err)
		ce.Hint = "Codex desktop app or CLI not found, so the everme marketplace cache was not refreshed; install Codex and retry"
		return ce
	}
	cmd := exec.CommandContext(ctx,
		codexExecutable,
		"plugin", "marketplace", "upgrade",
		codexMarketplaceName,
	)
	cmd.WaitDelay = 30 * time.Second
	var captured bytes.Buffer
	cmd.Stderr = &captured
	cmd.Stdout = &captured
	if err := cmd.Run(); err != nil {
		ce := output.IOErr("codex plugin marketplace upgrade", "exec", err)
		ce.Hint = fmt.Sprintf(
			"Marketplace upgrade failed, so the everme plugin cache may be stale. Run `codex plugin marketplace upgrade %s` manually when network is available. Codex CLI output: %s",
			codexMarketplaceName, trimForHint(captured.String()))
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
func (w *codexWriter) Commit(_ context.Context, plan *WritePlan, params WriteParams) (*WriteResult, error) {
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
	body, err := buildEnvFileBody(PlatformCodex, params)
	if err != nil {
		return nil, output.Internal(err)
	}

	// [mcp_servers.everme.env] carries the freshly minted evt token, so
	// config.toml is credential-bearing even though everme.env exists too.
	if err := writeCodexConfig(plan.ConfigPath, cfg, configCarriesToken); err != nil {
		return nil, err
	}
	envPath := filepath.Join(filepath.Dir(plan.ConfigPath), "everme.env")
	if err := writeFileAtomic(envPath, []byte(body), 0o600); err != nil {
		return nil, output.IOErr(envPath, "write-env-file", err)
	}

	// The Dock/PATH caveat applies regardless of trust outcome — it's about
	// the hook's `node ...` command failing to spawn at runtime, a separate
	// concern from whether Codex has trusted the hook content. The manual
	// `/hooks` step is only needed when Prepare's automatic trust attempt
	// (w.trustErr) failed; on success there's nothing left for the user to do.
	nextSteps := []string{
		"if you start Codex from the macOS Dock rather than a terminal, confirm Codex resolves a Node on PATH: a Dock-launched app inherits the launchd PATH, which usually excludes a Node installed by a version manager, and the EverMe lifecycle hooks will fail to spawn even though they're trusted",
	}
	if w.trustErr != nil {
		nextSteps = append([]string{
			"start a new Codex session, open `/hooks`, then review and trust the EverMe lifecycle hooks — evercli could not establish trust automatically for this install (see the reported warning for why)",
		}, nextSteps...)
	}

	return &WriteResult{
		Platform:      PlatformCodex,
		ConfigPath:    plan.ConfigPath,
		BackupPath:    wroteBackup,
		WroteNewEntry: !plan.WillReplace,
		NextSteps:     nextSteps,
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
func (w *codexWriter) Verify(_ context.Context, result *WriteResult) error {
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
	envPath := filepath.Join(filepath.Dir(result.ConfigPath), "everme.env")
	if !codexEnvHasToken(envPath) {
		return output.IOErr(envPath, "verify", fmt.Errorf("EVERME_AGENT_TOKEN missing or empty"))
	}
	installedPath := w.installedPath
	if installedPath == "" {
		installedPath, err = findCodexInstalledPath(result.ConfigPath)
	}
	if err != nil {
		return output.IOErr(result.ConfigPath, "verify-hooks", err)
	}
	if err := validateCodexInstalledPath(installedPath); err != nil {
		return output.IOErr(installedPath, "verify-hooks", err)
	}
	// All on-disk checks passed; surface deferred Prepare-time warnings last,
	// in the order plugin-cache refresh, marketplace upgrade, hook trust —
	// each reaches the user as a warning without masking a genuinely broken
	// install. trustErr goes last because a broken plugin/marketplace
	// refresh is a more actionable root cause than a trust failure, and
	// trust can't be attempted meaningfully without a valid hooks.json
	// anyway (Prepare only calls it once installedPath is non-empty).
	if w.pluginInstallErr != nil {
		return w.pluginInstallErr
	}
	if w.upgradeErr != nil {
		return w.upgradeErr
	}
	if w.trustErr != nil {
		return w.trustErr
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
// Mode selection matches the JSON writer: see configWriteMode.
func writeCodexConfig(path string, cfg map[string]interface{}, secrecy configSecrecy) error {
	raw, err := toml.Marshal(cfg)
	if err != nil {
		return output.Internal(fmt.Errorf("marshal config: %w", err))
	}
	return writeConfigFileAtomic(path, raw, secrecy)
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
		"args":    []interface{}{"-y", "@everme/memory-mcp@latest"},
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

func codexEnvHasToken(path string) bool {
	raw, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(raw), "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if ok && strings.TrimSpace(key) == "EVERME_AGENT_TOKEN" && strings.TrimSpace(value) != "" {
			return true
		}
	}
	return false
}

func findCodexInstalledPath(configPath string) (string, error) {
	root := filepath.Join(
		filepath.Dir(configPath),
		"plugins", "cache", codexMarketplaceName, codexMcpEntryName,
	)
	versions, err := os.ReadDir(root)
	if err != nil {
		return "", fmt.Errorf("installed plugin cache missing under %s: %w", root, err)
	}
	var lastValidationErr error
	for i := len(versions) - 1; i >= 0; i-- {
		if !versions[i].IsDir() {
			continue
		}
		path := filepath.Join(root, versions[i].Name())
		if validationErr := validateCodexInstalledPath(path); validationErr == nil {
			return path, nil
		} else {
			lastValidationErr = validationErr
		}
	}
	if lastValidationErr != nil {
		return "", fmt.Errorf("installed EverMe plugin cache under %s is invalid: %w", root, lastValidationErr)
	}
	return "", fmt.Errorf("hooks/hooks.json missing from installed EverMe plugin cache under %s", root)
}

func validateCodexInstalledPath(installedPath string) error {
	info, err := os.Stat(installedPath)
	if err != nil {
		return fmt.Errorf("installed plugin path is missing: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("installed plugin path is not a directory")
	}
	hooksPath := filepath.Join(installedPath, "hooks", "hooks.json")
	hooksInfo, err := os.Stat(hooksPath)
	if err != nil {
		return fmt.Errorf("hooks/hooks.json missing: %w", err)
	}
	if hooksInfo.IsDir() {
		return fmt.Errorf("hooks/hooks.json is a directory")
	}
	runnerPath := filepath.Join(installedPath, "bin", "hook.mjs")
	runnerInfo, err := os.Stat(runnerPath)
	if err != nil {
		return fmt.Errorf("bin/hook.mjs missing: %w", err)
	}
	if runnerInfo.IsDir() {
		return fmt.Errorf("bin/hook.mjs is a directory")
	}
	return nil
}
