// Package plugin — Kimi Code support (stage-only footprint, Option 2).
//
// Kimi Code has NO headless install command (no `kimi plugin install`) and
// NO per-user secret injection. Its own `/plugins install` builds a rich,
// internal installed.json record (absolute root, parsed+embedded manifest,
// diagnostics, skillCount, …) via its `recordFrom` builder. A minimal record
// direct-written by evercli passes the top-level `Array.isArray(plugins)`
// check but Kimi Code silently fails to load the plugin (no embedded
// manifest, no absolute root). Reproducing that internal record is too
// brittle, so evercli no longer writes installed.json at all.
//
// Instead evercli OWNS exactly two paths under the Kimi Code home
// (kimicodeHome(): EVERCLI_KIMICODE_CONFIG_DIR > KIMI_CODE_HOME > ~/.kimi-code):
//
//	<home>/everme.env   ← evt credentials (0600), read by the plugin at runtime
//	<home>/everme/      ← recursive copy of the @everme/kimicode bundle,
//	                       INCLUDING node_modules so hooks can resolve
//	                       `@everme/agent-sdk` at runtime
//
// evercli does NOT write <home>/plugins/managed/... and does NOT write
// <home>/plugins/installed.json — those belong to Kimi Code's own
// `/plugins install`. The user finishes registration by running
// `/plugins install <home>/everme` inside Kimi Code (the unavoidable manual
// last step, since Kimi Code ships no headless installer).
//
// Wire model:
//
//	detector
//	  → "Installed" iff <home> dir exists OR `kimi` CLI is on PATH.
//	  → "HasEverMeEntry" iff <home>/everme.env exists (non-empty token) AND
//	     <home>/everme/kimi.plugin.json exists — i.e. evercli has staged it.
//
//	writer.Plan
//	  → resolves the bundle source (env override > $(npm root -g)/@everme/kimicode).
//	     If unresolved, Plan does NOT install (Writer contract: no on-disk side
//	     effects) — it previews the deferred `npm install -g @everme/kimicode`.
//	     Snapshots everme.env mtime/size for the TOCTOU check. PreviewEntry
//	     surfaces the stage dir and the `/plugins install` registration hint.
//
//	writer.Commit (after the backend mints a fresh evt)
//	  1. assertNoConcurrentChange (TOCTOU guard).
//	  2. resolve the bundle source; if it is not on disk, run
//	     `npm install -g @everme/kimicode` (fail-hard — no bundle, nothing to
//	     stage). This is the npm step evercli automates for you; the TUI
//	     `/plugins install` registration below stays manual.
//	  3. mkdir <home> (0700).
//	  4. recursively copy the bundle into <home>/everme/ (overwrite; skip
//	     .git only — node_modules IS copied so hooks resolve at runtime).
//	  5. if <home>/everme/node_modules is absent (dev source), best-effort
//	     `npm install --omit=dev`; warn (not fail) if npm is missing/fails.
//	  6. write everme.env (0600) via buildEnvFileBody.
//
//	writer.Verify
//	  → everme.env has a non-empty EVERME_AGENT_TOKEN=evt_ and
//	     <home>/everme/kimi.plugin.json exists.
package plugin

import (
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

// kimiCommand resolves the `kimi` CLI binary. EVERCLI_KIMICODE_CMD lets
// tests point at a stub (or a nonexistent path to neutralize the PATH
// heuristic) without messing with $PATH. Mirrors claudeCommand().
func kimiCommand() string {
	if v := os.Getenv("EVERCLI_KIMICODE_CMD"); v != "" {
		return v
	}
	return "kimi"
}

// kimicodeHome resolves the Kimi Code home directory. Priority:
//
//	EVERCLI_KIMICODE_CONFIG_DIR (test/override) > KIMI_CODE_HOME > ~/.kimi-code
func kimicodeHome() (string, error) {
	if dir := os.Getenv("EVERCLI_KIMICODE_CONFIG_DIR"); dir != "" {
		return dir, nil
	}
	if dir := os.Getenv("KIMI_CODE_HOME"); dir != "" {
		return dir, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", output.IOErr("kimicode", "resolve-home", err)
	}
	return filepath.Join(home, ".kimi-code"), nil
}

// kimicodeStageDir returns <home>/everme — the staged bundle directory
// evercli copies the @everme/kimicode bundle into. The user registers it
// with Kimi Code via `/plugins install <stageDir>`.
func kimicodeStageDir(home string) string {
	return filepath.Join(home, "everme")
}

// kimicodeEnvPath returns <home>/everme.env.
func kimicodeEnvPath(home string) string {
	return filepath.Join(home, "everme.env")
}

// ---- detector ------------------------------------------------------

type kimiCodeDetector struct{}

func (kimiCodeDetector) Platform() Platform { return PlatformKimiCode }

func (kimiCodeDetector) DisplayName() string { return "Kimi Code" }

func (kimiCodeDetector) Detect(_ context.Context) (*Detection, error) {
	home, err := kimicodeHome()
	if err != nil {
		return &Detection{Platform: PlatformKimiCode, DisplayName: "Kimi Code"}, nil
	}
	envPath := kimicodeEnvPath(home)
	d := &Detection{
		Platform:    PlatformKimiCode,
		DisplayName: "Kimi Code",
		ConfigPath:  envPath,
	}

	// Dual heuristic: home dir present, or `kimi` on PATH.
	if _, statErr := os.Stat(home); statErr == nil {
		d.Installed = true
	}
	if !d.Installed {
		if _, lpErr := exec.LookPath(kimiCommand()); lpErr == nil {
			d.Installed = true
		}
	}

	// ConfigExists: evercli has written everme.env.
	if _, envErr := os.Stat(envPath); envErr == nil {
		d.ConfigExists = true
	}

	// Token-gated: everme.env must carry a non-empty token AND the bundle
	// must be staged (everme/kimi.plugin.json present). A half-written
	// footprint reads as not-configured so install (re)runs rather than skips.
	if d.ConfigExists && kimicodeEnvHasToken(envPath) {
		manifest := filepath.Join(kimicodeStageDir(home), "kimi.plugin.json")
		if _, mErr := os.Stat(manifest); mErr == nil {
			d.HasEverMeEntry = true
		}
	}
	return d, nil
}

// kimicodeEnvHasToken reports whether everme.env carries a non-empty
// EVERME_AGENT_TOKEN=evt_ entry.
func kimicodeEnvHasToken(envPath string) bool {
	body, err := os.ReadFile(envPath)
	if err != nil {
		return false
	}
	return strings.Contains(string(body), "EVERME_AGENT_TOKEN=evt_")
}

// ---- writer --------------------------------------------------------

// kimiCodeWriter implements Writer + Verifier. No Preparer: there is no
// out-of-band registration step before token mint — the entire footprint
// (everme.env + staged everme/ bundle) is materialized in Commit. The final
// `/plugins install` step is performed by the user inside Kimi Code.
type kimiCodeWriter struct {
	// pluginSource lets tests inject a fake bundle. Empty in production →
	// resolved at Plan/Commit time via kimicodePluginSource.
	pluginSource string
}

func newKimiCodeWriter() *kimiCodeWriter { return &kimiCodeWriter{} }

func (*kimiCodeWriter) Remove(_ context.Context, configPath string) (*RemoveResult, error) {
	abs, err := filepath.Abs(configPath)
	if err != nil {
		return nil, output.IOErr(configPath, "abs-path", err)
	}
	home := filepath.Dir(abs)
	stageDir := kimicodeStageDir(home)
	result := &RemoveResult{Platform: PlatformKimiCode, ConfigPath: abs}
	if _, envErr := os.Stat(abs); envErr != nil && errors.Is(envErr, fs.ErrNotExist) {
		if _, dirErr := os.Stat(stageDir); dirErr != nil && errors.Is(dirErr, fs.ErrNotExist) {
			return result, nil
		}
	} else if envErr != nil {
		return nil, output.IOErr(abs, "stat-env", envErr)
	}
	if _, envErr := os.Stat(abs); envErr == nil {
		// protected=true: everme.env carries the live agent token.
		backup, berr := backupFile(abs, true)
		if berr != nil {
			return nil, berr
		}
		result.BackupPath = backup
		if err := os.Remove(abs); err != nil {
			return nil, output.IOErr(abs, "remove-env", err)
		}
	}
	if err := os.RemoveAll(stageDir); err != nil {
		return nil, output.IOErr(stageDir, "remove-plugin", err)
	}
	result.Removed = true
	return result, nil
}

func (*kimiCodeWriter) Platform() Platform { return PlatformKimiCode }

func (*kimiCodeWriter) UninstallNextSteps() []string {
	return []string{
		"If Kimi Code still lists EverMe, run `/plugins remove everme` in its TUI to unregister the managed plugin entry.",
	}
}

// kimicodePluginSource resolves the @everme/kimicode bundle directory.
// Order of resolution (mirrors claude_code.go's pluginSourceSpec):
//
//	test override (struct field)                  → unit tests
//	$EVERCLI_KIMICODE_PLUGIN_SOURCE (env)         → override / dev
//	`$(npm root -g)/@everme/kimicode`             → production: already on disk
//	`npm install -g @everme/kimicode` + retry     → production: not yet present
//
// Return tuple is (source, resolved, err):
//
//   - installIfMissing=false (Plan): never install and never fail — if the
//     bundle is unresolved, return ("", false, nil) so the caller can render
//     a "would npm-install at Commit" preview (Writer contract: Plan has no
//     on-disk side effects).
//   - installIfMissing=true (Commit): if the bundle is unresolved, run
//     `npm install -g @everme/kimicode` and re-probe. FAIL-HARD on any
//     failure — the global package IS the bundle source, so with no bundle
//     there is nothing to stage and no meaningful degraded path.
func (w *kimiCodeWriter) kimicodePluginSource(ctx context.Context, installIfMissing bool) (string, bool, error) {
	if w.pluginSource != "" {
		return w.pluginSource, true, nil
	}
	if v := os.Getenv("EVERCLI_KIMICODE_PLUGIN_SOURCE"); v != "" {
		fmt.Fprintf(os.Stderr,
			"warning: using EVERCLI_KIMICODE_PLUGIN_SOURCE override (%q); set this only if you know why\n",
			v,
		)
		return v, true, nil
	}
	if p := globalNpmKimicodePath(); p != "" {
		return p, true, nil
	}
	if !installIfMissing {
		// Plan path: don't install, but don't fail either — signal
		// "would install" so the dry-run preview can describe it. Commit
		// runs the actual `npm install -g`.
		return "", false, nil
	}
	if err := ensureNpmKimicodeInstalled(ctx); err != nil {
		return "", false, err
	}
	p := globalNpmKimicodePath()
	if p == "" {
		return "", false, fmt.Errorf("after `npm install -g @everme/kimicode`, the package is still not resolvable via `npm root -g`; check npm's global prefix")
	}
	return p, true, nil
}

// ensureNpmKimicodeInstalled runs `npm install -g @everme/kimicode`, streaming
// output to our stderr so the user sees npm's download/extract progress (5–30s
// on a slow link; a silent CLI looks hung). Uses ctx for cancellation;
// WaitDelay grants a small grace window to flush if ctx is cancelled. Mirrors
// claude_code.go's ensureNpmPluginInstalled.
func ensureNpmKimicodeInstalled(ctx context.Context) error {
	npm, err := exec.LookPath("npm")
	if err != nil {
		return fmt.Errorf("npm not found on PATH — install Node 18+ from nodejs.org or your package manager, then retry: %w", err)
	}
	fmt.Fprintln(os.Stderr, "Installing @everme/kimicode from npm…")
	cmd := exec.CommandContext(ctx, npm, "install", "-g", "@everme/kimicode")
	cmd.WaitDelay = 5 * time.Second
	cmd.Stderr = os.Stderr
	cmd.Stdout = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("`npm install -g @everme/kimicode` failed: %w", err)
	}
	return nil
}

// globalNpmKimicodePath probes `npm root -g` for a global install of
// @everme/kimicode. Returns "" if npm is missing, errors, or the package
// (with its kimi.plugin.json manifest) is not present. No error is
// surfaced here — the caller treats "" as unresolved.
func globalNpmKimicodePath() string {
	npm, err := exec.LookPath("npm")
	if err != nil {
		return ""
	}
	cmd := exec.Command(npm, "root", "-g")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	root := strings.TrimSpace(string(out))
	if root == "" {
		return ""
	}
	candidate := filepath.Join(root, "@everme", "kimicode")
	if _, mErr := readKimicodeManifest(candidate); mErr != nil {
		return ""
	}
	return candidate
}

func (w *kimiCodeWriter) Plan(ctx context.Context, configPath string) (*WritePlan, error) {
	if configPath == "" {
		return nil, output.Invalid("configPath is required", "")
	}
	abs, err := filepath.Abs(configPath)
	if err != nil {
		return nil, output.IOErr(configPath, "abs-path", err)
	}

	// Resolve the bundle source. Plan must not install — installIfMissing
	// is false (Writer contract: Plan has no on-disk side effects). If the
	// bundle isn't on disk yet, resolved=false and we preview the deferred
	// `npm install -g`; Commit runs it.
	source, resolved, srcErr := w.kimicodePluginSource(ctx, false)
	if srcErr != nil {
		return nil, srcErr
	}

	home := filepath.Dir(abs) // <home>/everme.env → <home>
	stageDir := kimicodeStageDir(home)

	plan := &WritePlan{Platform: PlatformKimiCode, ConfigPath: abs}

	// Snapshot the everme.env file for the TOCTOU check.
	if info, statErr := os.Stat(abs); statErr == nil {
		plan.SnapshotModTime = info.ModTime().UnixNano()
		plan.SnapshotSize = info.Size()
		plan.WillReplace = true
	} else {
		plan.WillCreate = true
	}

	previewSource := source
	if !resolved {
		previewSource = "<would npm install -g @everme/kimicode at Commit>"
	}
	plan.PreviewEntry = map[string]interface{}{
		"pluginSource": previewSource,
		"envFile":      abs,
		"stageDir":     stageDir,
		"registerHint": fmt.Sprintf("in Kimi Code, run `/plugins install %s` to finish registration", stageDir),
		"agentId":      "agt_<assigned-on-commit>",
		"agentToken":   "evt_<assigned-on-commit>",
	}
	return plan, nil
}

func (w *kimiCodeWriter) Commit(ctx context.Context, plan *WritePlan, params WriteParams) (*WriteResult, error) {
	if plan == nil {
		return nil, output.Internal(fmt.Errorf("nil plan"))
	}
	// 1. TOCTOU guard.
	if err := assertNoConcurrentChange(plan); err != nil {
		return nil, err
	}

	home := filepath.Dir(plan.ConfigPath) // <home>/everme.env → <home>

	// 2. Re-resolve the bundle source. Plan deliberately skipped the npm
	//    install (Writer contract), so installIfMissing=true here may be the
	//    call that actually runs `npm install -g @everme/kimicode`. FAIL-HARD:
	//    with no bundle there is nothing to stage. The resolved bool is unused
	//    — Commit surfaces an error rather than degrading.
	source, _, srcErr := w.kimicodePluginSource(ctx, true)
	if srcErr != nil {
		ce := output.IOErr("@everme/kimicode", "resolve-plugin-source", srcErr)
		ce.Hint = "ensure `npm` is on your PATH and you can reach the public npm registry, or set EVERCLI_KIMICODE_PLUGIN_SOURCE to the bundle directory"
		return nil, ce
	}

	// 3. Ensure <home> (0700, token-bearing).
	if err := os.MkdirAll(home, 0o700); err != nil {
		return nil, output.IOErr(home, "mkdir-home", err)
	}

	// 4. Copy the bundle into <home>/everme/ (overwrite to target version).
	//    The dest is wiped first, then copied. .git is skipped; node_modules
	//    IS copied so the hooks can resolve @everme/agent-sdk at runtime.
	stageDir := kimicodeStageDir(home)
	if err := copyTreeAtomic(source, stageDir); err != nil {
		return nil, err
	}

	// 5. If the staged bundle has no node_modules (dev source without deps),
	//    best-effort `npm install --omit=dev`. Never fail the whole Commit:
	//    creds + bundle are still written; the user can npm install manually.
	var warnings []string
	if _, nmErr := os.Stat(filepath.Join(stageDir, "node_modules")); os.IsNotExist(nmErr) {
		if w := installKimicodeDeps(stageDir); w != "" {
			warnings = append(warnings, w)
		}
	}

	// 6. Write everme.env (0600) via the shared env-file formatter.
	body, err := buildEnvFileBody(PlatformKimiCode, params)
	if err != nil {
		return nil, output.Internal(err)
	}
	if err := writeFileAtomic(kimicodeEnvPath(home), []byte(body), 0o600); err != nil {
		return nil, output.IOErr(kimicodeEnvPath(home), "write-env-file", err)
	}

	for _, msg := range warnings {
		fmt.Fprintf(os.Stderr, "warning: %s\n", msg)
	}

	return &WriteResult{
		Platform:      PlatformKimiCode,
		ConfigPath:    plan.ConfigPath,
		WroteNewEntry: !plan.WillReplace,
		// evercli only staged the bundle + creds; Kimi Code has no headless
		// install command, so registration is the user's manual last step.
		NextSteps: []string{
			fmt.Sprintf("in the Kimi Code TUI, run `/plugins install %s` to register (no headless install)", stageDir),
		},
	}, nil
}

// installKimicodeDeps runs `npm install --omit=dev --no-audit --no-fund` in
// stageDir to populate node_modules for a dev source that shipped without
// deps. It NEVER fails the caller: it returns a non-empty warning string if
// npm is missing or the install fails (creds + bundle are still written;
// the user can run npm install manually), or "" on success.
func installKimicodeDeps(stageDir string) string {
	npm, err := exec.LookPath("npm")
	if err != nil {
		return fmt.Sprintf("npm not found; %s/node_modules not installed — run `npm install --omit=dev` there manually so the plugin hooks resolve", stageDir)
	}
	cmd := exec.Command(npm, "install", "--omit=dev", "--no-audit", "--no-fund")
	cmd.Dir = stageDir
	if out, runErr := cmd.CombinedOutput(); runErr != nil {
		return fmt.Sprintf("npm install in %s failed (%v); run it manually so the plugin hooks resolve: %s", stageDir, runErr, strings.TrimSpace(string(out)))
	}
	return ""
}

// Verify re-reads on-disk state: everme.env carries a non-empty token and
// the staged bundle manifest exists.
func (w *kimiCodeWriter) Verify(_ context.Context, result *WriteResult) error {
	if result == nil {
		return output.Internal(fmt.Errorf("nil result"))
	}
	home := filepath.Dir(result.ConfigPath) // <home>/everme.env → <home>

	envPath := kimicodeEnvPath(home)
	envBody, err := os.ReadFile(envPath)
	if err != nil {
		return output.IOErr(envPath, "verify", err)
	}
	if !strings.Contains(string(envBody), "EVERME_AGENT_TOKEN=evt_") {
		return output.IOErr(envPath, "verify",
			fmt.Errorf("everme.env has no agent token"))
	}

	manifest := filepath.Join(kimicodeStageDir(home), "kimi.plugin.json")
	if _, err := os.Stat(manifest); err != nil {
		return output.IOErr(manifest, "verify", fmt.Errorf("staged bundle manifest missing after Commit"))
	}
	return nil
}

// ---- bundle manifest -----------------------------------------------

// kimicodeManifest is the subset of kimi.plugin.json we read.
type kimicodeManifest struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// readKimicodeManifest reads the bundle manifest, trying kimi.plugin.json
// at the bundle root first, then .kimi-plugin/plugin.json. Returns an
// error if neither is present/parseable. Used by globalNpmKimicodePath to
// confirm a global install really is the @everme/kimicode bundle.
func readKimicodeManifest(bundle string) (*kimicodeManifest, error) {
	candidates := []string{
		filepath.Join(bundle, "kimi.plugin.json"),
		filepath.Join(bundle, ".kimi-plugin", "plugin.json"),
	}
	var lastErr error
	for _, p := range candidates {
		raw, err := os.ReadFile(p)
		if err != nil {
			lastErr = err
			continue
		}
		var m kimicodeManifest
		if err := json.Unmarshal(raw, &m); err != nil {
			lastErr = err
			continue
		}
		return &m, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no manifest found")
	}
	return nil, lastErr
}

// ---- recursive copy ------------------------------------------------

// copyTreeAtomic recursively copies src into dest, creating dirs at 0755
// and files at 0644 (written atomically via writeFileAtomic). dest is wiped
// first so a re-install fully replaces the prior staged bundle (no stale
// files linger). .git directories are skipped; node_modules IS copied so
// the plugin hooks can resolve their runtime deps from the staged tree.
func copyTreeAtomic(src, dest string) error {
	srcInfo, err := os.Stat(src)
	if err != nil {
		return output.IOErr(src, "stat-bundle", err)
	}
	if !srcInfo.IsDir() {
		return output.Invalid(
			fmt.Sprintf("plugin bundle source %s is not a directory", src),
			"EVERCLI_KIMICODE_PLUGIN_SOURCE must point at the @everme/kimicode bundle directory")
	}

	// Wipe dest first so a re-install fully replaces the prior bundle.
	if err := os.RemoveAll(dest); err != nil {
		return output.IOErr(dest, "rm-dest", err)
	}

	return filepath.WalkDir(src, func(path string, dEntry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return output.IOErr(path, "walk-bundle", walkErr)
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return output.IOErr(path, "rel-bundle", err)
		}
		if rel == "." {
			if err := os.MkdirAll(dest, 0o755); err != nil {
				return output.IOErr(dest, "mkdir-dest", err)
			}
			return nil
		}

		base := dEntry.Name()
		if dEntry.IsDir() {
			// Skip .git only — node_modules IS copied (hooks need deps).
			if base == ".git" {
				return fs.SkipDir
			}
			target := filepath.Join(dest, rel)
			if err := os.MkdirAll(target, 0o755); err != nil {
				return output.IOErr(target, "mkdir-dest", err)
			}
			return nil
		}

		// Skip symlinks and other non-regular files defensively.
		if !dEntry.Type().IsRegular() {
			return nil
		}

		body, err := os.ReadFile(path)
		if err != nil {
			return output.IOErr(path, "read-bundle-file", err)
		}
		target := filepath.Join(dest, rel)
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return output.IOErr(filepath.Dir(target), "mkdir-dest", err)
		}
		if err := writeFileAtomic(target, body, 0o644); err != nil {
			return output.IOErr(target, "write-bundle-file", err)
		}
		return nil
	})
}
