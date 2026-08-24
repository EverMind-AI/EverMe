package plugin

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"evercli/internal/output"
)

type fileSnapshot struct {
	Path    string
	Exists  bool
	ModTime int64
	Size    int64
}

type hookSpec struct {
	Event string
	Entry map[string]interface{}
}

type nativeHookWriter struct {
	platform   Platform
	hooksPath  func(string) string
	mergeHooks func(map[string]interface{}) error
	// legacyConfigPaths lists config locations this host used to keep, so
	// Remove can clean an install made before the host moved. Nil for
	// hosts that never moved. Only consulted when Remove was asked for
	// canonicalConfigPath — see Remove.
	legacyConfigPaths func() []string
	// canonicalConfigPath is this host's current config location.
	canonicalConfigPath func() (string, error)
}

func newNativeHookWriter(
	platform Platform,
	hooksPath func(string) string,
	mergeHooks func(map[string]interface{}) error,
) *nativeHookWriter {
	return &nativeHookWriter{platform: platform, hooksPath: hooksPath, mergeHooks: mergeHooks}
}

// withLegacyCleanup enables sweeping older config locations, but only
// when Remove is asked for `canonical`. Keying the sweep off $HOME alone
// would let a Remove of any unrelated path reach into the user's real
// install — which is exactly what happened once.
func (w *nativeHookWriter) withLegacyCleanup(canonical func() (string, error), legacy func() []string) *nativeHookWriter {
	w.canonicalConfigPath = canonical
	w.legacyConfigPaths = legacy
	return w
}

func (w *nativeHookWriter) Platform() Platform { return w.platform }

// Remove cleans the requested config and every legacy location this host
// used to keep. Devin's own "copy your config to the new location" prompt
// duplicates the agent token across both, so clearing only the path the
// caller named would leave a live token on disk.
func (w *nativeHookWriter) Remove(ctx context.Context, configPath string) (*RemoveResult, error) {
	r, err := w.removeAt(ctx, configPath)
	if err != nil {
		return nil, err
	}
	if w.legacyConfigPaths == nil || w.canonicalConfigPath == nil {
		return r, nil
	}
	// Sweep only when this is an uninstall of the host's own config. A
	// Remove aimed at some other file must stay inside that file.
	canonical, cErr := w.canonicalConfigPath()
	if cErr != nil || canonical != configPath {
		return r, nil
	}
	for _, legacy := range w.legacyConfigPaths() {
		if legacy == r.ConfigPath {
			continue
		}
		legacyResult, err := w.removeAt(ctx, legacy)
		if err != nil {
			return nil, err
		}
		if legacyResult.Removed {
			r.Removed = true
		}
	}
	return r, nil
}

func (w *nativeHookWriter) removeAt(ctx context.Context, configPath string) (*RemoveResult, error) {
	r, err := newMCPWriter(w.platform).Remove(ctx, configPath)
	if err != nil {
		return nil, err
	}
	envPath := filepath.Join(filepath.Dir(r.ConfigPath), "everme.env")
	if _, statErr := os.Stat(envPath); statErr == nil {
		if rmErr := os.Remove(envPath); rmErr != nil {
			return nil, output.IOErr(envPath, "remove-env", rmErr)
		}
		r.Removed = true
	} else if !errorsIsNotExist(statErr) {
		return nil, output.IOErr(envPath, "stat-env", statErr)
	}
	hp := w.hooksPath(r.ConfigPath)
	if hp != r.ConfigPath {
		cfg, exists, err := readConfig(hp)
		if err != nil {
			return nil, err
		}
		if exists && cfg != nil {
			if changed := removeEverMeHooks(cfg); changed {
				if _, err := backupFile(hp, false); err != nil {
					return nil, err
				}
				// Hook entries are command lines, never credentials.
				if err := writeConfigAtomic(hp, cfg, configHasNoToken); err != nil {
					return nil, err
				}
				r.Removed = true
			}
		}
	}
	return r, nil
}

// removeEverMeHooks strips EverMe-owned hook entries from cfg in place
// and reports whether anything was dropped. It handles both hook-config
// shapes this codebase has ever written:
//
//   - map of event → entry array ({"hooks": {"stop": [entries]}}) — the
//     shape mergeFlatHooks writes for Cursor and Devin;
//   - a flat entry array ({"hooks": [entries]}) — legacy shape kept for
//     configs written before the map layout landed.
//
// Ownership is decided by the entry's "command" field containing one of the
// exact npm packages this writer has installed. A generic "everme" substring
// match would delete unrelated user commands such as backup-everme-notes.sh.
func removeEverMeHooks(cfg map[string]interface{}) bool {
	changed := false
	for _, key := range []string{"hooks", "lifecycleHooks"} {
		switch value := cfg[key].(type) {
		case map[string]interface{}:
			for event, raw := range value {
				entries, ok := raw.([]interface{})
				if !ok {
					continue
				}
				if kept, dropped := dropEverMeHookEntries(entries); dropped {
					value[event] = kept
					changed = true
				}
			}
		case []interface{}:
			if kept, dropped := dropEverMeHookEntries(value); dropped {
				cfg[key] = kept
				changed = true
			}
		}
	}
	return changed
}

// dropEverMeHookEntries filters EverMe-owned rows out of one entry
// array. Non-map entries and entries without a string command are kept
// verbatim — we only ever delete what mergeFlatHooks could have written.
func dropEverMeHookEntries(entries []interface{}) ([]interface{}, bool) {
	kept := make([]interface{}, 0, len(entries))
	dropped := false
	for _, entry := range entries {
		if row, ok := entry.(map[string]interface{}); ok {
			if command, ok := row["command"].(string); ok && isManagedEverMeHookCommand(command) {
				dropped = true
				continue
			}
		}
		kept = append(kept, entry)
	}
	return kept, dropped
}

func isManagedEverMeHookCommand(command string) bool {
	managedPackages := [...]string{
		"@everme/cursor",
		"@everme/devin",
		"@everme/windsurf",
	}
	for _, field := range strings.Fields(strings.ToLower(command)) {
		token := strings.Trim(field, `"'`)
		for _, packageName := range managedPackages {
			if token == packageName || strings.HasPrefix(token, packageName+"@") {
				return true
			}
		}
	}
	return false
}

func (w *nativeHookWriter) Plan(ctx context.Context, configPath string) (*WritePlan, error) {
	plan, err := newMCPWriter(w.platform).Plan(ctx, configPath)
	if err != nil {
		return nil, err
	}
	hooksPath := w.hooksPath(plan.ConfigPath)
	if hooksPath != plan.ConfigPath {
		cfg, _, err := readConfig(hooksPath)
		if err != nil {
			return nil, err
		}
		if cfg == nil {
			cfg = map[string]interface{}{}
		}
		if err := w.mergeHooks(cfg); err != nil {
			return nil, invalidHookConfig(hooksPath, err)
		}
		snapshot, err := captureFileSnapshot(hooksPath)
		if err != nil {
			return nil, err
		}
		plan.auxiliaryFiles = append(plan.auxiliaryFiles, snapshot)
	} else {
		cfg, _, err := readConfig(plan.ConfigPath)
		if err != nil {
			return nil, err
		}
		if cfg == nil {
			cfg = map[string]interface{}{}
		}
		if err := w.mergeHooks(cfg); err != nil {
			return nil, invalidHookConfig(hooksPath, err)
		}
	}

	envPath := filepath.Join(filepath.Dir(plan.ConfigPath), "everme.env")
	envSnapshot, err := captureFileSnapshot(envPath)
	if err != nil {
		return nil, err
	}
	plan.auxiliaryFiles = append(plan.auxiliaryFiles, envSnapshot)
	return plan, nil
}

func (w *nativeHookWriter) Commit(_ context.Context, plan *WritePlan, params WriteParams) (*WriteResult, error) {
	if plan == nil {
		return nil, output.Internal(fmt.Errorf("nil plan"))
	}
	primary := fileSnapshot{
		Path:    plan.ConfigPath,
		Exists:  !plan.WillCreate,
		ModTime: plan.SnapshotModTime,
		Size:    plan.SnapshotSize,
	}
	if err := assertFileSnapshot(primary); err != nil {
		return nil, err
	}
	for _, snapshot := range plan.auxiliaryFiles {
		if err := assertFileSnapshot(snapshot); err != nil {
			return nil, err
		}
	}

	envBody, err := buildEnvFileBody(w.platform, params)
	if err != nil {
		return nil, output.Internal(err)
	}
	primaryCfg, primaryExists, err := readConfig(plan.ConfigPath)
	if err != nil {
		return nil, err
	}
	if primaryCfg == nil {
		primaryCfg = map[string]interface{}{}
	}
	if err := nestedMcpUpsertEntry(
		primaryCfg,
		claudeCodeServersPath,
		mcpEntryName,
		buildEntry(params.APIBaseURL, params.AgentID, params.AgentToken),
	); err != nil {
		return nil, output.Invalid(
			fmt.Sprintf("config at %s has a shape collision under mcp.*: %v", plan.ConfigPath, err),
			"Fix the config file's shape manually, then retry install",
		)
	}

	hooksPath := w.hooksPath(plan.ConfigPath)
	hooksCfg := primaryCfg
	hooksExists := primaryExists
	if hooksPath != plan.ConfigPath {
		hooksCfg, hooksExists, err = readConfig(hooksPath)
		if err != nil {
			return nil, err
		}
		if hooksCfg == nil {
			hooksCfg = map[string]interface{}{}
		}
	}
	if err := w.mergeHooks(hooksCfg); err != nil {
		return nil, invalidHookConfig(hooksPath, err)
	}

	wroteBackup := ""
	if primaryExists {
		// protected=true: the pre-rewrite config may already carry a
		// live evt token, so the backup must be 0600 regardless of the
		// original file's mode.
		wroteBackup, err = backupFile(plan.ConfigPath, true)
		if err != nil {
			return nil, err
		}
	}
	if hooksPath != plan.ConfigPath && hooksExists {
		if _, err := backupFile(hooksPath, false); err != nil {
			return nil, err
		}
	}
	envPath := filepath.Join(filepath.Dir(plan.ConfigPath), "everme.env")
	if envSnapshot := findSnapshot(plan.auxiliaryFiles, envPath); envSnapshot.Exists {
		if _, err := backupFile(envPath, true); err != nil {
			return nil, err
		}
	}

	// The MCP entry upserted into primaryCfg carries the freshly minted
	// evt token. hooksCfg is only a separate file here (when it is not,
	// the write above already covered it) and holds command lines only.
	if err := writeConfigAtomic(plan.ConfigPath, primaryCfg, configCarriesToken); err != nil {
		return nil, err
	}
	if hooksPath != plan.ConfigPath {
		if err := writeConfigAtomic(hooksPath, hooksCfg, configHasNoToken); err != nil {
			return nil, err
		}
	}
	if err := writeFileAtomic(envPath, []byte(envBody), 0o600); err != nil {
		return nil, output.IOErr(envPath, "write-env-file", err)
	}

	return &WriteResult{
		Platform:      w.platform,
		ConfigPath:    plan.ConfigPath,
		BackupPath:    wroteBackup,
		WroteNewEntry: !plan.WillReplace,
	}, nil
}

func mergeFlatHooks(cfg map[string]interface{}, owner string, specs []hookSpec) error {
	hooks, err := ensureObject(cfg, "hooks")
	if err != nil {
		return err
	}
	for _, spec := range specs {
		entries, err := eventEntries(hooks, spec.Event)
		if err != nil {
			return err
		}
		kept := make([]interface{}, 0, len(entries)+1)
		for _, entry := range entries {
			row, ok := entry.(map[string]interface{})
			if ok {
				if command, ok := row["command"].(string); ok && strings.Contains(command, owner) {
					continue
				}
			}
			kept = append(kept, entry)
		}
		kept = append(kept, cloneMap(spec.Entry))
		hooks[spec.Event] = kept
	}
	return nil
}

func ensureObject(parent map[string]interface{}, key string) (map[string]interface{}, error) {
	value, present := parent[key]
	if !present || value == nil {
		object := map[string]interface{}{}
		parent[key] = object
		return object, nil
	}
	object, ok := value.(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("%s must be an object", key)
	}
	return object, nil
}

func eventEntries(hooks map[string]interface{}, event string) ([]interface{}, error) {
	value, present := hooks[event]
	if !present || value == nil {
		return []interface{}{}, nil
	}
	entries, ok := value.([]interface{})
	if !ok {
		return nil, fmt.Errorf("hooks.%s must be an array", event)
	}
	return entries, nil
}

func captureFileSnapshot(path string) (fileSnapshot, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return fileSnapshot{}, output.IOErr(path, "abs-path", err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		if errorsIsNotExist(err) {
			return fileSnapshot{Path: abs}, nil
		}
		return fileSnapshot{}, output.IOErr(abs, "stat", err)
	}
	return fileSnapshot{Path: abs, Exists: true, ModTime: info.ModTime().UnixNano(), Size: info.Size()}, nil
}

func assertFileSnapshot(snapshot fileSnapshot) error {
	info, err := os.Stat(snapshot.Path)
	if !snapshot.Exists {
		if err == nil {
			return concurrentFileError(snapshot.Path, "create")
		}
		if errorsIsNotExist(err) {
			return nil
		}
		return output.IOErr(snapshot.Path, "stat", err)
	}
	if err != nil {
		if errorsIsNotExist(err) {
			return concurrentFileError(snapshot.Path, "remove")
		}
		return output.IOErr(snapshot.Path, "stat", err)
	}
	if info.ModTime().UnixNano() != snapshot.ModTime || info.Size() != snapshot.Size {
		return concurrentFileError(snapshot.Path, "edit")
	}
	return nil
}

func concurrentFileError(path, action string) error {
	ce := output.IOErr(path, "concurrent-"+action, fmt.Errorf("file changed between Plan and Commit"))
	ce.Hint = "Another process changed the file; re-run `evercli plugin install` to re-plan against the latest content"
	return ce
}

func backupFile(path string, protected bool) (string, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return "", output.IOErr(path, "read-for-backup", err)
	}
	mode := os.FileMode(0o600)
	if !protected {
		if info, statErr := os.Stat(path); statErr == nil {
			mode = info.Mode().Perm()
		}
	}
	backupPath := path + backupSuffix
	if err := writeFileAtomic(backupPath, body, mode); err != nil {
		return "", output.IOErr(backupPath, "write-backup", err)
	}
	return backupPath, nil
}

func findSnapshot(snapshots []fileSnapshot, path string) fileSnapshot {
	for _, snapshot := range snapshots {
		if snapshot.Path == path {
			return snapshot
		}
	}
	return fileSnapshot{Path: path}
}

func invalidHookConfig(path string, err error) error {
	return output.Invalid(
		fmt.Sprintf("hook config at %s has an unsupported shape: %v", path, err),
		"Fix the hook config shape manually, then retry install",
	)
}

func cloneMap(value map[string]interface{}) map[string]interface{} {
	copy := make(map[string]interface{}, len(value))
	for key, item := range value {
		copy[key] = item
	}
	return copy
}

func errorsIsNotExist(err error) bool {
	return err != nil && (os.IsNotExist(err) || err == fs.ErrNotExist)
}
