// Package plugin — Claude Code support.
//
// This file owns the entire EverMe ↔ Claude Code wiring: detector,
// writer, and the helpers they share (env-file path resolution,
// claude CLI discovery, plugin source spec). Pairs with
// @everme/claude-code in plugins/claude-code/.
//
// Wire model:
//
//	detector
//	  → "Installed" iff `claude` CLI is in PATH or ~/.claude.json
//	     exists (host-presence signal, not plugin-registration).
//	  → "HasEverMeEntry" combines (a) the env file evercli wrote and
//	     (b) `claude plugin list` agreement; if the user manually
//	     uninstalled the plugin, the registry wins.
//
//	writer.Plan
//	  → confirms `claude` is in PATH; resolves the plugin source
//	     (env override > monorepo dev path > GitHub URL); snapshots
//	     any pre-existing env file for TOCTOU detection.
//
//	writer.Commit (after the backend mints a fresh evt)
//	  1. write ~/.claude/everme.env (KEY=value, 0600, atomic) so the
//	     plugin's hooks/scripts/lib/config.js picks up evt without
//	     the user having to mutate their shell profile.
//	  2. `claude plugin marketplace add <source>` when the marketplace is
//	     absent or its recorded directory moved, else `claude plugin
//	     marketplace update everme` — `add` on an already-registered
//	     source only prints "already on disk" and re-reads nothing.
//	  3. `claude plugin install everme@everme` when nothing is cached,
//	     else `claude plugin update everme@everme` — `install` on an
//	     installed plugin prints "already installed" and leaves the old
//	     cache directory in place.
//
//	writer.Verify
//	  → env file carries a token, and the version Claude Code recorded in
//	     ~/.claude/plugins/installed_plugins.json equals the version the
//	     payload declares. Every shell-out above exits 0 in states that
//	     keep a stale cache, so this comparison is the only proof the user
//	     ends up running what we shipped.
//
//	writer.Remove
//	  1. `claude plugin uninstall everme`          (best-effort)
//	  2. `claude plugin marketplace remove everme` (best-effort)
//	  3. delete ~/.claude/everme.env
//
// Atomicity: the env file is written via .tmp + rename so the plugin
// never sees a half-written file. Every `claude` shell-out is safe to
// re-run, so a partial commit is safe to retry.
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
	"strings"
	"time"

	"evercli/internal/output"
)

// We always pin our marketplace name to `everme` and our plugin name
// to `everme` so install commands are unambiguous.
const (
	everMarketplaceName = "everme"
	evermePluginName    = "everme"

	// evermePluginSpec is the `<plugin>@<marketplace>` form. It is
	// unambiguous when another marketplace registers a plugin of the same
	// name, and `claude plugin update` accepts nothing else — the bare
	// name fails with `Plugin "everme" not found`.
	evermePluginSpec = evermePluginName + "@" + everMarketplaceName
)

// claudeCommand resolves the `claude` CLI binary. EVERCLI_CLAUDE_CMD
// lets tests point at a stub without messing with $PATH.
func claudeCommand() string {
	if v := os.Getenv("EVERCLI_CLAUDE_CMD"); v != "" {
		return v
	}
	return "claude"
}

// envFilePath returns ~/.claude/everme.env — the location the plugin's
// lib/config.js reads as its env fallback so we don't have to mutate
// the user's shell profile.
func envFilePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude", "everme.env"), nil
}

// ---- Claude Code plugin state (read-only) --------------------------
//
// Claude Code tracks plugin state in two JSON files under
// ~/.claude/plugins/. We only ever READ them — the claude CLI owns the
// writes. They answer the two questions exit codes can't: which verb to
// use (install vs update) and whether the cache actually moved.

const (
	claudeInstalledPluginsFile  = "installed_plugins.json"
	claudeKnownMarketplacesFile = "known_marketplaces.json"

	// Scope of the entries evercli installs. Claude Code also supports
	// project scope; a project-scoped copy is the user's own doing and
	// not ours to reason about.
	claudePluginUserScope = "user"
)

// claudePluginsDir returns ~/.claude/plugins. Mirrors envFilePath's
// convention of resolving ~/.claude from the home directory.
func claudePluginsDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude", "plugins"), nil
}

// claudeInstalledPluginsPath is the best-effort display path used in
// error messages. Falls back to the bare filename when the home
// directory can't be resolved — a hint string is not worth an error.
func claudeInstalledPluginsPath() string {
	dir, err := claudePluginsDir()
	if err != nil {
		return claudeInstalledPluginsFile
	}
	return filepath.Join(dir, claudeInstalledPluginsFile)
}

// claudeCachedPluginVersion returns the plugin version Claude Code has
// cached for everme@everme at user scope.
//
// ("", nil) means "nothing cached": the file is absent, carries no entry
// for us, or the entry has no version. Each of those states means the
// caller should install rather than update. A malformed file IS an error
// — reporting it as "not installed" would silently pick the wrong verb
// and hide a broken host.
func claudeCachedPluginVersion() (string, error) {
	dir, err := claudePluginsDir()
	if err != nil {
		return "", output.IOErr(claudeInstalledPluginsFile, "resolve-home", err)
	}
	path := filepath.Join(dir, claudeInstalledPluginsFile)
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", nil
		}
		return "", output.IOErr(path, "read", err)
	}
	var parsed struct {
		Plugins map[string][]struct {
			Scope   string `json:"scope"`
			Version string `json:"version"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", output.IOErr(path, "parse-json", err)
	}
	for _, entry := range parsed.Plugins[evermePluginSpec] {
		if entry.Scope == claudePluginUserScope {
			return entry.Version, nil
		}
	}
	return "", nil
}

// claudeMarketplaceRegistration reports whether our marketplace is
// registered and, for a local-directory source, the path it points at.
// The path is empty for github / URL sources: those record a checkout
// location instead, which must never be compared against our source spec.
//
// Read failures degrade to (false, "") on purpose — the caller then falls
// back to `marketplace add`, which is the correct move in any state we
// can't read.
func claudeMarketplaceRegistration() (registered bool, dirSource string) {
	dir, err := claudePluginsDir()
	if err != nil {
		return false, ""
	}
	raw, err := os.ReadFile(filepath.Join(dir, claudeKnownMarketplacesFile))
	if err != nil {
		return false, ""
	}
	var parsed map[string]struct {
		Source struct {
			Source string `json:"source"`
			Path   string `json:"path"`
		} `json:"source"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return false, ""
	}
	entry, ok := parsed[everMarketplaceName]
	if !ok {
		return false, ""
	}
	return true, entry.Source.Path
}

// claudeSourceManifestVersion reads the plugin version the payload at
// source declares. The marketplace entry wins: it is the version Claude
// Code names its cache directory after. .claude-plugin/plugin.json is the
// fallback for a payload whose marketplace entry omits the field (bump.sh
// keeps both in sync, but only one is load-bearing here).
//
// ("", nil) means "not comparable", not "version zero": https sources
// can't be read without a network fetch, and a payload declaring no
// version anywhere gives us nothing to assert against.
func claudeSourceManifestVersion(source string) (string, error) {
	if source == "" || !filepath.IsAbs(source) {
		return "", nil
	}

	marketplacePath := filepath.Join(source, ".claude-plugin", "marketplace.json")
	raw, err := os.ReadFile(marketplacePath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", nil
		}
		return "", output.IOErr(marketplacePath, "read", err)
	}
	var marketplace struct {
		Plugins []struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(raw, &marketplace); err != nil {
		return "", output.IOErr(marketplacePath, "parse-json", err)
	}
	for _, p := range marketplace.Plugins {
		if p.Name == evermePluginName && p.Version != "" {
			return p.Version, nil
		}
	}

	manifestPath := filepath.Join(source, ".claude-plugin", "plugin.json")
	raw, err = os.ReadFile(manifestPath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", nil
		}
		return "", output.IOErr(manifestPath, "read", err)
	}
	var manifest struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return "", output.IOErr(manifestPath, "parse-json", err)
	}
	return manifest.Version, nil
}

// ClaudePluginVersionDrift compares what Claude Code has cached against
// what the resolved @everme/claude-code payload declares. Two empty
// strings mean "nothing to compare" — no payload on disk, plugin not
// installed, or an https source we can't read — so callers skip instead
// of warning.
//
// Exported for `evercli doctor`: the installer's Verify covers the
// install moment, this covers every host that drifted afterwards.
func ClaudePluginVersionDrift(ctx context.Context) (cached, available string, err error) {
	// installIfMissing=false: doctor is a read-only diagnostic and must
	// never mutate global node_modules.
	source, resolved, err := (&claudeCodeWriter{}).pluginSourceSpec(ctx, false)
	if err != nil || !resolved {
		return "", "", nil
	}
	available, err = claudeSourceManifestVersion(source)
	if err != nil || available == "" {
		return "", "", err
	}
	cached, err = claudeCachedPluginVersion()
	if err != nil {
		return "", "", err
	}
	return cached, available, nil
}

// ---- detector ------------------------------------------------------

type claudeCodeDetector struct{}

func (claudeCodeDetector) Platform() Platform { return PlatformClaudeCode }

func (claudeCodeDetector) DisplayName() string { return "Claude Code" }

func (claudeCodeDetector) Detect(ctx context.Context) (*Detection, error) {
	envPath, _ := envFilePath()
	d := &Detection{
		Platform:    PlatformClaudeCode,
		DisplayName: "Claude Code",
		ConfigPath:  envPath,
	}

	// "Installed" semantics: the host (Claude Code itself) is present
	// on this machine. Two heuristics — either is sufficient.
	if _, err := exec.LookPath(claudeCommand()); err == nil {
		d.Installed = true
	}
	if !d.Installed {
		if home, err := os.UserHomeDir(); err == nil {
			if _, err := os.Stat(filepath.Join(home, ".claude.json")); err == nil {
				d.Installed = true
			}
		}
	}

	// "ConfigExists" / "HasEverMeEntry": evercli-managed env file +
	// plugin registration with Claude Code.
	if envPath != "" {
		if _, err := os.Stat(envPath); err == nil {
			d.ConfigExists = true
			d.HasEverMeEntry = true
		} else if !os.IsNotExist(err) {
			return d, err
		}
	}

	// Cross-check `claude plugin list` so the user manually
	// uninstalling the plugin (without evercli involvement) is
	// reflected. EVERCLI_SKIP_CLAUDE_LIST=1 bypasses for CI.
	if d.HasEverMeEntry && os.Getenv("EVERCLI_SKIP_CLAUDE_LIST") != "1" {
		if registered, err := claudeListContainsEverme(ctx); err == nil {
			d.HasEverMeEntry = registered
		}
	}
	return d, nil
}

// claudeListContains is the single grep-style parser for `claude <sub>
// list` output. We substring-match by name because CC's list output has
// shifted across versions (plain text → table-formatted → with health-
// check prefix) and substring is the only shape that tolerates all of
// them.
//
// FRAGILITY NOTE — read before touching:
//
// This works as long as `everme` only appears in CC's list output as
// either our own plugin row OR our own MCP server row. If CC ever
// emits an unrelated row whose DESCRIPTION text contains the literal
// "everme" (e.g. another plugin saying "compatible with everme"),
// we'll false-positive. The blast radius is benign for the doctor
// check (just a misreport), but `isPluginRegistered` uses this to
// decide install/skip — a false positive would short-circuit install.
//
// Future-proofing: if CC ships `claude plugin list --format json` /
// `claude mcp list --format json`, switch to structured parse here
// (every caller passes through this helper, so it's a single edit).
func claudeListContains(out []byte, name string) bool {
	return bytes.Contains(out, []byte(name))
}

func claudeListContainsEverme(ctx context.Context) (bool, error) {
	if _, err := exec.LookPath(claudeCommand()); err != nil {
		return false, err
	}
	cmd := exec.CommandContext(ctx, claudeCommand(), "plugin", "list")
	cmd.WaitDelay = 5 * time.Second
	out, err := cmd.Output()
	if err != nil {
		return false, err
	}
	return claudeListContains(out, evermePluginName), nil
}

// ClaudeMcpListContainsEverme reports whether `claude mcp list` lists
// the bundled everme MCP server. Exported so `evercli doctor` can run
// the same probe without re-implementing the shell-out / env override.
//
// Distinct from claudeListContainsEverme: that one checks plugin
// registration, this one checks whether the plugin's bundled MCP
// server has been approved by the user via `/mcp` in Claude Code. A
// healthy install has BOTH true; a half-installed one has plugin=true
// + mcp=false (hooks work, the MCP tools don't surface).
func ClaudeMcpListContainsEverme(ctx context.Context) (bool, error) {
	if _, err := exec.LookPath(claudeCommand()); err != nil {
		return false, err
	}
	cmd := exec.CommandContext(ctx, claudeCommand(), "mcp", "list")
	cmd.WaitDelay = 5 * time.Second
	out, err := cmd.Output()
	if err != nil {
		return false, err
	}
	return claudeListContains(out, evermePluginName), nil
}

// ---- writer --------------------------------------------------------

// claudeCodeWriter installs the EverMe plugin via Claude Code's plugin
// system: marketplace add → plugin install. The full @everme/claude-code
// package — hooks (SessionStart / UserPromptSubmit / Stop / SessionEnd),
// commands (`/recall`, `/everme-help`), the memory-tools skill, and
// the bundled MCP server — gets registered in one shot.
type claudeCodeWriter struct {
	// pluginSource lets tests inject a fake source. Empty in production
	// → resolved at Plan time via pluginSourceSpec().
	pluginSource string

	// resolvedSource is the source Commit actually handed to the claude
	// CLI. Verify reads the payload's manifest from it to assert the
	// cache moved; Plan's value is deliberately not reused (Commit may
	// npm-install and resolve a path Plan never saw).
	resolvedSource string
}

func newClaudeCodeWriter() *claudeCodeWriter { return &claudeCodeWriter{} }

// Remove undoes what Commit wired up: best-effort `claude plugin
// uninstall` + `claude plugin marketplace remove`, then deletes the
// evercli-owned env file.
//
// configPath is the detector's ConfigPath — ~/.claude/everme.env, a
// KEY=value file. It must NEVER flow through the JSON mcpWriter.Remove
// path: that writer json-parses the file and fails on the '#' comment
// header, which used to make every `plugin uninstall claude-code` fail.
func (w *claudeCodeWriter) Remove(ctx context.Context, configPath string) (*RemoveResult, error) {
	// Guard: an empty configPath must not silently become
	// filepath.Abs("") == cwd — resolve the canonical env path instead.
	envPath := configPath
	if envPath == "" {
		p, err := envFilePath()
		if err != nil {
			return nil, output.IOErr("env-file", "resolve-home", err)
		}
		envPath = p
	}
	abs, err := filepath.Abs(envPath)
	if err != nil {
		return nil, output.IOErr(envPath, "abs-path", err)
	}
	result := &RemoveResult{Platform: PlatformClaudeCode, ConfigPath: abs}

	// Best-effort host deregistration. Failures (plugin already
	// uninstalled by hand, marketplace entry gone) surface as stderr
	// warnings but never block the local cleanup — Remove stays
	// idempotent. When the claude CLI isn't on PATH there is nothing
	// to deregister from, so we skip silently.
	if _, lookErr := exec.LookPath(claudeCommand()); lookErr == nil {
		if runErr := runClaude(ctx, "plugin", "uninstall", evermePluginName); runErr != nil {
			fmt.Fprintf(os.Stderr,
				"warning: `claude plugin uninstall %s` failed: %v — if it still shows in `claude plugin list`, remove it manually\n",
				evermePluginName, runErr)
		}
		if runErr := runClaude(ctx, "plugin", "marketplace", "remove", everMarketplaceName); runErr != nil {
			fmt.Fprintf(os.Stderr,
				"warning: `claude plugin marketplace remove %s` failed: %v\n",
				everMarketplaceName, runErr)
		}
	}

	// Delete the env file. Missing file is a successful no-op
	// (Removed=false) per the Remover contract.
	switch _, statErr := os.Stat(abs); {
	case statErr == nil:
		if rmErr := os.Remove(abs); rmErr != nil {
			return nil, output.IOErr(abs, "remove-env", rmErr)
		}
		result.Removed = true
	case !os.IsNotExist(statErr):
		return nil, output.IOErr(abs, "stat-env", statErr)
	}
	return result, nil
}

func (claudeCodeWriter) Platform() Platform { return PlatformClaudeCode }

// pluginSourceSpec is the argument we pass to `claude plugin
// marketplace add`. Order of resolution:
//
//	test override (struct field)                   → unit tests
//	$EVERCLI_CLAUDE_PLUGIN_SOURCE (env)            → escape hatch (dev points at
//	                                                  $PWD/plugins/claude-code/,
//	                                                  or anyone forcing a fork)
//	`$(npm root -g)/@everme/claude-code/`          → production: located on disk
//	                                                  after npm install ran
//	`npm install -g @everme/claude-code` + retry   → production: not yet present
//
// We deliberately do NOT walk the filesystem for a mono-repo dev path
// here. That dev fallback (now removed) was the very thing that hid the
// production bug it was meant to be a "shortcut" for — Mac devs always
// hit the dev path, the prod path could rot indefinitely. Same code
// path in dev and prod means prod bugs surface on dev too.
//
// pluginSourceAllowed below enforces a strict whitelist (https URL or
// absolute local path) before we hand the returned value to the claude
// CLI as an argument. We don't run claude through a shell, so injection
// requires the downstream CLI to mis-parse — but treating arbitrary
// env input as untrusted closes that gap.
//
// installIfMissing controls whether the install-fallback branch is
// allowed to run `npm install -g`. Plan MUST pass false — the Writer
// contract (types.go) forbids on-disk side effects at Plan time, and a
// dry-run preview would otherwise mutate global node_modules. Commit
// passes true. When Plan can't resolve a path without installing, it
// returns ("", false, nil) so the caller can surface a preview that
// says "would npm-install @everme/claude-code".
func (w *claudeCodeWriter) pluginSourceSpec(ctx context.Context, installIfMissing bool) (string, bool, error) {
	if w.pluginSource != "" {
		return w.pluginSource, true, nil
	}
	if v := os.Getenv("EVERCLI_CLAUDE_PLUGIN_SOURCE"); v != "" {
		// Surface the override loudly. A hostile direnv / dotfile could
		// silently redirect every install to an attacker-supplied
		// marketplace; pluginSourceAllowed gates the value's shape, but
		// the user still deserves to see WHEN the override is honored
		// so anomalies are easy to spot in the terminal scroll.
		fmt.Fprintf(os.Stderr,
			"warning: using EVERCLI_CLAUDE_PLUGIN_SOURCE override (%q); set this only if you know why\n",
			v,
		)
		return v, true, nil
	}
	if p, err := globalNpmPluginPath(ctx); err == nil && p != "" {
		return p, true, nil
	}
	if !installIfMissing {
		// Plan path: don't install, but don't fail either — return a
		// "would install" signal so the dry-run preview can describe
		// it. Commit will run the install.
		return "", false, nil
	}
	if err := ensureNpmPluginInstalled(ctx); err != nil {
		return "", false, err
	}
	p, err := globalNpmPluginPath(ctx)
	if err != nil {
		return "", false, err
	}
	if p == "" {
		return "", false, fmt.Errorf("after `npm install -g @everme/claude-code`, the package is still not resolvable via `npm root -g`; check npm's global prefix")
	}
	return p, true, nil
}

// globalNpmPluginPath probes `npm root -g` for an existing global
// install of @everme/claude-code. Returns ("", nil) if the package is
// not installed (or npm reports a root that doesn't contain it);
// returns ("", err) only for npm-itself failures (npm missing,
// `npm root -g` exits non-zero).
//
// We additionally stat .claude-plugin/marketplace.json inside the
// candidate directory: an `npm install` interrupted at the wrong moment
// can leave a partial directory, and `claude plugin marketplace add`
// would 404 inside it without a helpful error.
func globalNpmPluginPath(ctx context.Context) (string, error) {
	npm, err := exec.LookPath("npm")
	if err != nil {
		return "", fmt.Errorf("npm not found on PATH: %w", err)
	}
	cmd := exec.CommandContext(ctx, npm, "root", "-g")
	cmd.WaitDelay = 5 * time.Second
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("`npm root -g` failed: %w", err)
	}
	root := strings.TrimSpace(string(out))
	if root == "" {
		return "", nil
	}
	candidate := filepath.Join(root, "@everme", "claude-code")
	if _, err := os.Stat(filepath.Join(candidate, ".claude-plugin", "marketplace.json")); err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	return candidate, nil
}

// ensureNpmPluginInstalled runs `npm install -g @everme/claude-code`,
// streaming stderr to our stderr so the user sees the progress (npm's
// download/extract phase can take 5–30s on a slow link, and a silent
// CLI looks hung). Uses ctx for cancellation; WaitDelay grants a small
// grace window to flush stderr if the parent context is cancelled.
func ensureNpmPluginInstalled(ctx context.Context) error {
	npm, err := exec.LookPath("npm")
	if err != nil {
		return fmt.Errorf("npm not found on PATH — install Node 18+ from nodejs.org or your package manager, then retry: %w", err)
	}
	fmt.Fprintln(os.Stderr, "Installing @everme/claude-code from npm…")
	cmd := exec.CommandContext(ctx, npm, "install", "-g", "@everme/claude-code")
	cmd.WaitDelay = 5 * time.Second
	cmd.Stderr = os.Stderr
	cmd.Stdout = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("`npm install -g @everme/claude-code` failed: %w", err)
	}
	return nil
}

// pluginSourceAllowed validates a plugin source spec. We accept exactly
// two shapes: an https URL (production / GitHub fork), or an absolute
// local path (dev / tests). Anything else — relative paths, http://,
// git+ssh://, plain git refs — is rejected at Plan time so a typo /
// hostile env can't cause the claude CLI to reach an attacker-supplied
// origin.
func pluginSourceAllowed(s string) error {
	s = strings.TrimSpace(s)
	if s == "" {
		return fmt.Errorf("plugin source is empty")
	}
	if strings.ContainsAny(s, "\r\n\t \"'") {
		return fmt.Errorf("plugin source contains whitespace or quotes")
	}
	if strings.HasPrefix(s, "https://") {
		return nil
	}
	if filepath.IsAbs(s) {
		return nil
	}
	return fmt.Errorf("plugin source must be an https URL or absolute local path; got %q", s)
}

func (w *claudeCodeWriter) Plan(ctx context.Context, configPath string) (*WritePlan, error) {
	if _, err := exec.LookPath(claudeCommand()); err != nil {
		ce := output.IOErr("claude", "lookup-cli", err)
		ce.Hint = "Install Claude Code from https://claude.ai/code, then retry. Or pass --keep-agent to skip the local install step."
		return nil, ce
	}

	// Plan must not install: writer.Plan is contractually side-effect-
	// free (see types.go::Writer). If the plugin isn't on disk yet,
	// resolved=false and we surface "would install" in the preview;
	// Commit runs the actual `npm install -g`.
	source, resolved, err := w.pluginSourceSpec(ctx, false)
	if err != nil {
		ce := output.IOErr("@everme/claude-code", "resolve-plugin-source", err)
		ce.Hint = "Ensure `npm` is on your PATH and you can reach the public npm registry. To override, set EVERCLI_CLAUDE_PLUGIN_SOURCE to an https URL or absolute local path."
		return nil, ce
	}
	if resolved {
		if err := pluginSourceAllowed(source); err != nil {
			ce := output.Invalid(err.Error(),
				"Set EVERCLI_CLAUDE_PLUGIN_SOURCE to an https URL or absolute local path, or ensure `npm install -g @everme/claude-code` succeeds")
			ce.Detail = map[string]interface{}{"source": source}
			return nil, ce
		}
	}

	envPath := configPath
	if envPath == "" {
		var err error
		envPath, err = envFilePath()
		if err != nil {
			return nil, output.IOErr("env-file", "resolve-home", err)
		}
	}
	envPath, err = filepath.Abs(envPath)
	if err != nil {
		return nil, output.IOErr(configPath, "abs-path", err)
	}

	previewSource := source
	if !resolved {
		previewSource = "<would npm install -g @everme/claude-code at Commit>"
	}
	plan := &WritePlan{
		Platform:   PlatformClaudeCode,
		ConfigPath: envPath,
		PreviewEntry: map[string]interface{}{
			"installVia":   "claude plugin install",
			"pluginSource": previewSource,
			"envFile":      envPath,
			"agentId":      "agt_<assigned-on-commit>",
			"agentToken":   "evt_<assigned-on-commit>",
		},
	}
	if info, statErr := os.Stat(envPath); statErr == nil {
		plan.SnapshotModTime = info.ModTime().UnixNano()
		plan.SnapshotSize = info.Size()
		plan.WillReplace = true
	} else {
		plan.WillCreate = true
	}
	return plan, nil
}

func (w *claudeCodeWriter) Commit(ctx context.Context, plan *WritePlan, params WriteParams) (*WriteResult, error) {
	if plan == nil {
		return nil, output.Internal(fmt.Errorf("nil plan"))
	}

	// C3 TOCTOU check: refuse to overwrite when the env file changed
	// (mtime/size shifted) or appeared (Plan saw nothing, Commit sees
	// one) since Plan. Same shared helper the JSON writer uses, so
	// behaviour is uniform across hosts.
	if err := assertNoConcurrentChange(plan); err != nil {
		return nil, err
	}

	envPath := plan.ConfigPath
	if err := os.MkdirAll(filepath.Dir(envPath), 0o700); err != nil {
		return nil, output.IOErr(envPath, "mkdir-claude-dir", err)
	}

	body, err := buildEnvFileBody(PlatformClaudeCode, params)
	if err != nil {
		return nil, output.Internal(err)
	}
	if err := writeFileAtomic(envPath, []byte(body), 0o600); err != nil {
		return nil, output.IOErr(envPath, "write-env-file", err)
	}

	// Re-resolve the plugin source. Plan deliberately skipped the npm
	// install (Writer contract: Plan has no on-disk side effects), so
	// this call may be the one that actually runs `npm install -g`.
	// installIfMissing=true is the production path; the resolved bool
	// is unused here because Commit must surface an error rather than
	// degrade.
	source, _, err := w.pluginSourceSpec(ctx, true)
	if err != nil {
		return nil, output.IOErr("@everme/claude-code", "resolve-plugin-source", err)
	}
	if err := pluginSourceAllowed(source); err != nil {
		ce := output.Invalid(err.Error(),
			"Set EVERCLI_CLAUDE_PLUGIN_SOURCE to an https URL or absolute local path, or ensure `npm install -g @everme/claude-code` succeeds")
		ce.Detail = map[string]interface{}{"source": source}
		return nil, ce
	}

	w.resolvedSource = source

	// 1. Register the marketplace, or refresh the registered one.
	if err := w.syncMarketplace(ctx, source); err != nil {
		ce := output.IOErr("claude plugin marketplace add", "exec", err)
		ce.Hint = "marketplace add failed — this is NOT a GitHub auth issue. The plugin source is a local directory (" + source + "); inspect the stderr above. If the directory is missing, run `npm install -g @everme/claude-code` manually. Do not run `gh auth login`."
		ce.Detail = map[string]any{"source": source}
		return nil, ce
	}

	// 2. Install the plugin, or update the cached one. Re-running install
	//    is NOT a refresh: Claude Code prints "already installed", exits
	//    0, and keeps serving the previous cache directory — which is how
	//    an upgraded payload on disk never reaches the user.
	registered, _ := w.isPluginRegistered(ctx)
	cachedVersion, cacheErr := claudeCachedPluginVersion()
	if cacheErr != nil {
		// Degrade rather than abort: the env file is already written and
		// the token already minted, so failing Commit here would strand a
		// live agent. installOrUpdatePlugin's fallback covers the wrong
		// guess, and Verify still reports the drift.
		fmt.Fprintf(os.Stderr, "warning: could not read Claude Code's installed-plugin state (%v); assuming a fresh install\n", cacheErr)
	}
	if err := w.installOrUpdatePlugin(ctx, cachedVersion != ""); err != nil {
		ce := output.IOErr("claude plugin install", "exec", err)
		ce.Hint = "Neither `claude plugin update " + evermePluginSpec + "` nor `claude plugin install " + evermePluginSpec + "` succeeded. Check `claude plugin list` and the stderr above; env file at " + envPath + " is in place."
		return nil, ce
	}

	// A running Claude Code keeps the previous payload loaded until it
	// restarts, so an actual version move is worth a next step.
	var nextSteps []string
	if newVersion, err := claudeCachedPluginVersion(); err == nil && cachedVersion != "" && newVersion != "" && newVersion != cachedVersion {
		nextSteps = append(nextSteps, fmt.Sprintf(
			"restart Claude Code so plugin %s replaces the %s payload still loaded in running sessions",
			newVersion, cachedVersion))
	}

	// 3. Post-install MCP visibility probe. `claude plugin install`
	//    exit-0 only proves the plugin is registered; the bundled MCP
	//    server is gated by a separate user-consent step (`/mcp`
	//    inside Claude Code, writing enabledMcpjsonServers). Warn —
	//    don't fail — so the hook half of the plugin works regardless
	//    while the user gets a concrete next step. Probe failures
	//    (claude CLI gone, non-zero exit) are non-fatal because they
	//    likely indicate a Claude Code restart is needed anyway.
	if visible, err := ClaudeMcpListContainsEverme(ctx); err == nil && !visible {
		fmt.Fprintln(os.Stderr, "WARNING: plugin installed but its MCP server isn't visible to Claude Code yet.")
		fmt.Fprintln(os.Stderr, "         Open Claude Code, run `/mcp`, and approve the `everme` server")
		fmt.Fprintln(os.Stderr, "         so tools like mem_search become callable. Hooks (auto-recall,")
		fmt.Fprintln(os.Stderr, "         auto-save) work without this — only manual MCP tool calls need it.")
	}

	return &WriteResult{
		Platform:      PlatformClaudeCode,
		ConfigPath:    envPath,
		WroteNewEntry: !registered,
		NextSteps:     nextSteps,
	}, nil
}

// Verify asserts the two things the shell-outs' exit codes cannot prove:
// the env file carries a token, and Claude Code's plugin cache sits on
// the version the payload declares. `marketplace add` ("already on
// disk") and `plugin install` ("already installed") both exit 0 while
// leaving a stale cache, so without this comparison an install reports
// success while the user keeps running an old plugin.
//
// Per the Verifier contract (types.go) a failure here surfaces as a
// warning on the InstallEntry, not a failed install: at this point the
// token is on disk at 0600 and registered server-side.
func (w *claudeCodeWriter) Verify(_ context.Context, result *WriteResult) error {
	if result == nil {
		return output.Internal(fmt.Errorf("nil result"))
	}
	envBody, err := os.ReadFile(result.ConfigPath)
	if err != nil {
		return output.IOErr(result.ConfigPath, "verify", err)
	}
	if !strings.Contains(string(envBody), "EVERME_AGENT_TOKEN=evt_") {
		return output.IOErr(result.ConfigPath, "verify",
			fmt.Errorf("everme.env has no agent token"))
	}

	want, err := claudeSourceManifestVersion(w.resolvedSource)
	if err != nil {
		return err
	}
	if want == "" {
		// An https source (unreadable without a fetch) or a payload that
		// declares no version — nothing to compare. We skip rather than
		// guess a version we don't know.
		return nil
	}
	got, err := claudeCachedPluginVersion()
	if err != nil {
		return err
	}
	statePath := claudeInstalledPluginsPath()
	if got == "" {
		ce := output.IOErr(statePath, "verify-version",
			fmt.Errorf("Claude Code reports no cached everme plugin after install"))
		ce.Hint = "Run `claude plugin install " + evermePluginSpec + "`, then restart Claude Code"
		return ce
	}
	if got != want {
		ce := output.IOErr(statePath, "verify-version",
			fmt.Errorf("Claude Code has plugin %s cached but the payload on disk is %s", got, want))
		ce.Hint = "Run `claude plugin update " + evermePluginSpec + "`, then restart Claude Code"
		ce.Detail = map[string]any{"cached": got, "available": want}
		return ce
	}
	return nil
}

// syncMarketplace registers our marketplace or refreshes the registered
// one.
//
// `claude plugin marketplace add` is not a refresh: on an
// already-registered identical source it prints "already on disk" and
// exits 0 without re-reading anything, which is precisely how a stale
// marketplace survives a re-install. `marketplace update` is the refresh
// verb. `add` remains correct when the recorded directory source moved
// (npm's global prefix changed) — Claude Code then repoints the entry.
func (w *claudeCodeWriter) syncMarketplace(ctx context.Context, source string) error {
	registered, recorded := claudeMarketplaceRegistration()
	moved := recorded != "" && filepath.Clean(recorded) != filepath.Clean(source)
	if registered && !moved {
		if err := runClaude(ctx, "plugin", "marketplace", "update", everMarketplaceName); err == nil {
			return nil
		}
		// A broken entry (source deleted, manifest unreadable) fails the
		// update; re-adding is the repair path, so fall through rather
		// than abort the install.
	}
	return runClaude(ctx, "plugin", "marketplace", "add", source)
}

func (w *claudeCodeWriter) installPlugin(ctx context.Context) error {
	return runClaude(ctx, "plugin", "install", evermePluginSpec)
}

// updatePlugin refreshes an already-cached plugin. The qualified
// `<plugin>@<marketplace>` spec is load-bearing here, not cosmetic:
// `claude plugin update everme` fails with `Plugin "everme" not found`.
func (w *claudeCodeWriter) updatePlugin(ctx context.Context) error {
	return runClaude(ctx, "plugin", "update", evermePluginSpec)
}

// installOrUpdatePlugin picks the verb from what Claude Code has cached:
// update when a version is already there, install otherwise. When the
// chosen verb fails we try the other one once — installed_plugins.json
// and Claude Code's own view can disagree (a hand-deleted cache
// directory, an interrupted uninstall), and the fallback turns that into
// a working install instead of a hard failure. The first error is the one
// reported when both fail: it describes the state we expected to be in.
func (w *claudeCodeWriter) installOrUpdatePlugin(ctx context.Context, cached bool) error {
	first, second := w.installPlugin, w.updatePlugin
	if cached {
		first, second = w.updatePlugin, w.installPlugin
	}
	err := first(ctx)
	if err == nil {
		return nil
	}
	if secondErr := second(ctx); secondErr == nil {
		return nil
	}
	return err
}

// isPluginRegistered greps `claude plugin list` for our plugin name
// using the shared claudeListContains helper. Failure modes (CLI
// missing, exit non-zero) return false — the caller will run install
// which surfaces the real error.
func (w *claudeCodeWriter) isPluginRegistered(ctx context.Context) (bool, error) {
	cmd := exec.CommandContext(ctx, claudeCommand(), "plugin", "list")
	cmd.WaitDelay = 5 * time.Second
	out, err := cmd.Output()
	if err != nil {
		return false, err
	}
	return claudeListContains(out, evermePluginName), nil
}

// runClaude is the shared "spawn claude with context cancellation"
// helper. The previous exec.Command call ignored ctx entirely, so a
// hanging `claude plugin install` couldn't be interrupted by Ctrl+C
// or the global --timeout. WaitDelay gives the child a small grace
// window to flush stderr after cancellation before we kill it.
func runClaude(ctx context.Context, args ...string) error {
	cmd := exec.CommandContext(ctx, claudeCommand(), args...)
	cmd.WaitDelay = 5 * time.Second
	cmd.Stderr = os.Stderr
	cmd.Stdout = os.Stderr
	return cmd.Run()
}

// buildEnvFileBody renders the KEY=value file the plugin reads at
// startup. The leading marker tells the user (and the uninstall path)
// that evercli owns the file.
//
// Any value containing \r, \n, or NUL is rejected: those bytes would
// either inject a fake KEY=value line into the file or cause downstream
// shell loaders (`set -a; . everme.env`) to mis-parse — neither
// failure mode is what we want for a file derived from server-supplied
// material. The expectation is that the backend never produces such
// values, so a hit here is a hard error rather than silent escape.
func buildEnvFileBody(platform Platform, params WriteParams) (string, error) {
	for k, v := range map[string]string{
		"EVERME_API_BASE":    params.APIBaseURL,
		"EVERME_AGENT_ID":    params.AgentID,
		"EVERME_AGENT_TOKEN": params.AgentToken,
	} {
		if strings.ContainsAny(v, "\r\n\x00") {
			return "", fmt.Errorf("%s contains illegal control characters; refusing to write env file", k)
		}
	}

	p := string(platform)
	var b strings.Builder
	b.WriteString("# Managed by evercli plugin install " + p + " — do not edit by hand.\n")
	b.WriteString("# Re-run `evercli plugin install " + p + "` to refresh the token.\n")
	b.WriteString("# To remove: run `evercli plugin uninstall " + p + " --yes`.\n")
	b.WriteString("# Host-managed registries may still require: " + hostUninstallHint(platform) + ".\n")
	b.WriteString("EVERME_API_BASE=")
	b.WriteString(params.APIBaseURL)
	b.WriteString("\n")
	b.WriteString("EVERME_AGENT_ID=")
	b.WriteString(params.AgentID)
	b.WriteString("\n")
	b.WriteString("EVERME_AGENT_TOKEN=")
	b.WriteString(params.AgentToken)
	b.WriteString("\n")
	return b.String(), nil
}

// hostUninstallHint returns the host-specific guidance for removing the
// everme plugin, used in the everme.env header. Falls back to a generic
// note for platforms without a known host uninstall command.
func hostUninstallHint(platform Platform) string {
	switch platform {
	case PlatformClaudeCode:
		return "run `claude plugin uninstall everme`"
	case PlatformCodex:
		return "run `codex plugin uninstall everme@everme` and remove the EverMe MCP entry"
	case PlatformKimiCode:
		return "remove the everme plugin from Kimi Code (`/plugins remove everme`)"
	case PlatformDSH:
		return "restart DeepSeek Harness after removing the managed patch"
	default:
		return "remove the everme plugin from the host"
	}
}

// writeFileAtomic moved to mcp.go so both writers use the same .tmp +
// rename path with explicit-mode O_CREATE|O_EXCL. Keeping a single
// implementation prevents future divergence in token-permission
// handling.
