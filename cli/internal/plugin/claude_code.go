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
//	  2. `claude plugin marketplace add <source>`  (idempotent)
//	  3. `claude plugin install everme@everme`     (idempotent)
//
//	writer.Remove
//	  1. `claude plugin uninstall everme`          (best-effort)
//	  2. `claude plugin marketplace remove everme` (best-effort)
//	  3. delete ~/.claude/everme.env
//
// Atomicity: the env file is written via .tmp + rename so the plugin
// never sees a half-written file. The two `claude` shell-outs are
// each idempotent on the Claude Code side (re-add prints "already on
// disk"), so a partial commit is safe to retry.
package plugin

import (
	"bytes"
	"context"
	"fmt"
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
}

func newClaudeCodeWriter() *claudeCodeWriter { return &claudeCodeWriter{} }

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

	body, err := buildEnvFileBody(params)
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

	// 1. Add our marketplace (idempotent — Claude Code prints
	//    "already on disk" if the entry exists).
	if err := w.addMarketplace(ctx, source); err != nil {
		ce := output.IOErr("claude plugin marketplace add", "exec", err)
		ce.Hint = "marketplace add failed — this is NOT a GitHub auth issue. The plugin source is a local directory (" + source + "); inspect the stderr above. If the directory is missing, run `npm install -g @everme/claude-code` manually. Do not run `gh auth login`."
		ce.Detail = map[string]any{"source": source}
		return nil, ce
	}

	// 2. Install (or re-install) the plugin. We always run install so
	//    the user picks up the freshest hooks even on a re-run.
	registered, _ := w.isPluginRegistered(ctx)
	if err := w.installPlugin(ctx); err != nil {
		ce := output.IOErr("claude plugin install", "exec", err)
		ce.Hint = "Check `claude plugin list` and the stderr above; env file at " + envPath + " is in place."
		return nil, ce
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
		fmt.Fprintln(os.Stderr, "         so tools like everme_search become callable. Hooks (auto-recall,")
		fmt.Fprintln(os.Stderr, "         auto-save) work without this — only manual MCP tool calls need it.")
	}

	return &WriteResult{
		Platform:      PlatformClaudeCode,
		ConfigPath:    envPath,
		WroteNewEntry: !registered,
	}, nil
}

// (claudeCodeWriter.Remove was retired with `evercli plugin uninstall`.
// Manual cleanup steps for users:
//   1. `claude plugin uninstall everme`
//   2. `claude plugin marketplace remove everme`
//   3. `rm ~/.claude/everme.env`
// Plus disconnect the agent from the EverMe web UI.)

func (w *claudeCodeWriter) addMarketplace(ctx context.Context, source string) error {
	return runClaude(ctx, "plugin", "marketplace", "add", source)
}

func (w *claudeCodeWriter) installPlugin(ctx context.Context) error {
	// `<plugin>@<marketplace>` form is unambiguous even when other
	// marketplaces register a plugin of the same name.
	spec := evermePluginName + "@" + everMarketplaceName
	return runClaude(ctx, "plugin", "install", spec)
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
func buildEnvFileBody(params WriteParams) (string, error) {
	for k, v := range map[string]string{
		"EVERME_API_BASE":    params.APIBaseURL,
		"EVERME_AGENT_ID":    params.AgentID,
		"EVERME_AGENT_TOKEN": params.AgentToken,
	} {
		if strings.ContainsAny(v, "\r\n\x00") {
			return "", fmt.Errorf("%s contains illegal control characters; refusing to write env file", k)
		}
	}

	var b strings.Builder
	b.WriteString("# Managed by evercli plugin install claude-code — do not edit by hand.\n")
	b.WriteString("# Re-run `evercli plugin install claude-code` to refresh the token.\n")
	b.WriteString("# To remove: disconnect the agent from the EverMe web UI, then\n")
	b.WriteString("# `claude plugin uninstall everme` and delete this file manually.\n")
	b.WriteString("# (`evercli plugin uninstall` was retired in V1 — see SKILL §3.)\n")
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

// writeFileAtomic moved to mcp.go so both writers use the same .tmp +
// rename path with explicit-mode O_CREATE|O_EXCL. Keeping a single
// implementation prevents future divergence in token-permission
// handling.
