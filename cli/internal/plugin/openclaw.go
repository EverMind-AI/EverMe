package plugin

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"evercli/internal/output"
)

// OpenClawPluginID is the manifest id for the EverMe ContextEngine plugin
// that this writer installs into ~/.openclaw/openclaw.json. It MUST match
// all three sources of truth on the plugin side:
//
//   - plugins/openclaw/openclaw.plugin.json : id
//   - plugins/openclaw/package.json         : name (the npm package name)
//   - plugins/openclaw/package.json         : openclaw.id
//
// When they diverge OpenClaw logs "Plugin manifest id X differs from npm
// package name Y; using manifest id as the config key", which causes
// user-visible churn between docs (npm name) and on-disk config
// (manifest id). TestOpenClawPluginIDConsistency in openclaw_test.go
// asserts the four values stay in sync.
//
// OpenClaw uses this value as the config key under plugins.entries.<id>,
// the contextEngine slot value, and the allow-list entry.
const OpenClawPluginID = "@everme/openclaw"

// openclawDetector implements Detector for OpenClaw. Config lives at
// ~/.openclaw/openclaw.json (the canonical filename — verified against
// node_modules/openclaw/dist/configure-*.js, which references the file
// by name in its `Remove channel config` flow).
//
// Path override via $OPENCLAW_CONFIG_DIR keeps the parent directory
// configurable for tests and per-user installs; the filename itself is
// fixed because the real CLI does not look at any other name.
type openclawDetector struct{}

func (openclawDetector) Platform() Platform { return PlatformOpenClaw }

func (openclawDetector) DisplayName() string { return "OpenClaw" }

func (openclawDetector) Detect(_ context.Context) (*Detection, error) {
	path, err := OpenClawConfigPath()
	if err != nil {
		return &Detection{Platform: PlatformOpenClaw, DisplayName: "OpenClaw"}, nil
	}
	d := &Detection{
		Platform:    PlatformOpenClaw,
		DisplayName: "OpenClaw",
		ConfigPath:  path,
	}
	cfg, exists, err := readConfig(path)
	if err != nil {
		// Surface IO/parse errors so `plugin list` doesn't claim
		// "installed, no everme entry" when the file is unreadable.
		return d, err
	}
	d.ConfigExists = exists
	d.Installed = exists
	if exists {
		d.HasEverMeEntry = openclawHasEntry(cfg)
	}
	return d, nil
}

// OpenClawConfigPath returns the canonical OpenClaw config file
// (~/.openclaw/openclaw.json by default; $OPENCLAW_CONFIG_DIR overrides
// the parent dir).
func OpenClawConfigPath() (string, error) {
	if dir := os.Getenv("OPENCLAW_CONFIG_DIR"); dir != "" {
		return filepath.Join(dir, "openclaw.json"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".openclaw", "openclaw.json"), nil
}

// openclawWriter installs the EverMe ContextEngine plugin entry into
// ~/.openclaw/openclaw.json. Layout written by Commit:
//
//	plugins.allow                              ← add OpenClawPluginID
//	plugins.slots.contextEngine                ← OpenClawPluginID
//	plugins.entries.<OpenClawPluginID>.enabled ← true
//	plugins.entries.<OpenClawPluginID>.config  ← { apiBase, agentId,
//	                                               agentToken, topK,
//	                                               flushEveryTurns,
//	                                               flushMaxBytes }
//
// The plugin source itself is NOT installed by evercli — that's
// `openclaw plugins install @everme/openclaw` (npm spec) or
// `openclaw plugins install <path> --link` for dev. evercli only owns
// the per-agent config (apiBase + freshly minted agent_token).
//
// All on-disk I/O reuses readConfig / writeConfigAtomic /
// assertNoConcurrentChange from mcp.go so the safety properties
// (atomic rename, single-backup, TOCTOU rejection) are uniform across
// host writers.
type openclawWriter struct{}

func newOpenClawWriter() *openclawWriter { return &openclawWriter{} }

func (*openclawWriter) Platform() Platform { return PlatformOpenClaw }

// Plan validates the target path (parent writable, file parses as JSON
// if it exists) and records whether the entry already lives at
// plugins.entries.<id>.
func (*openclawWriter) Plan(_ context.Context, configPath string) (*WritePlan, error) {
	if configPath == "" {
		return nil, output.Invalid("configPath is required", "")
	}
	abs, err := filepath.Abs(configPath)
	if err != nil {
		return nil, output.IOErr(configPath, "abs-path", err)
	}

	plan := &WritePlan{Platform: PlatformOpenClaw, ConfigPath: abs}

	parent := filepath.Dir(abs)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return nil, output.IOErr(parent, "mkdir-parent", err)
	}

	cfg, exists, err := readConfig(abs)
	if err != nil {
		return nil, err
	}
	plan.WillCreate = !exists
	plan.WillReplace = openclawHasEntry(cfg)
	if exists {
		plan.BackupPath = abs + backupSuffix
		if info, statErr := os.Stat(abs); statErr == nil {
			plan.SnapshotModTime = info.ModTime().UnixNano()
			plan.SnapshotSize = info.Size()
		}
	}

	// Preview uses placeholders that visibly aren't tokens — Plan output
	// also feeds --dry-run, which a user might paste into an issue.
	plan.PreviewEntry = buildOpenClawEntry(
		"https://api.everme.evermind.ai",
		"<assigned-on-commit>",
		"<assigned-on-commit>",
	)
	return plan, nil
}

// Commit applies the plan: backup → upsert entry + slot binding +
// allow-list → atomic rewrite.
func (*openclawWriter) Commit(_ context.Context, plan *WritePlan, params WriteParams) (*WriteResult, error) {
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

	entry := buildOpenClawEntry(params.APIBaseURL, params.AgentID, params.AgentToken)
	if upErr := upsertOpenClawEntry(cfg, entry); upErr != nil {
		return nil, output.Invalid(
			fmt.Sprintf("config at %s has a shape collision under plugins.*: %v", plan.ConfigPath, upErr),
			"Fix the config file's shape manually (a plugins.* path collides with an unexpected non-object value), then retry install",
		)
	}

	if err := writeConfigAtomic(plan.ConfigPath, cfg); err != nil {
		return nil, err
	}

	return &WriteResult{
		Platform:      PlatformOpenClaw,
		ConfigPath:    plan.ConfigPath,
		BackupPath:    wroteBackup,
		WroteNewEntry: !plan.WillReplace,
	}, nil
}

// buildOpenClawEntry produces the entry shape OpenClaw expects under
// plugins.entries.<id>. config keys mirror the plugin's
// openclaw.plugin.json configSchema; the schema's defaults
// (topK=5, flushEveryTurns=5, flushMaxBytes=65536) are inlined here so
// a fresh install yields a fully-specified entry instead of relying on
// the plugin's runtime defaults — auditors reading the JSON should see
// the entire effective config.
func buildOpenClawEntry(apiBaseURL, agentID, agentToken string) map[string]interface{} {
	return map[string]interface{}{
		"enabled": true,
		"config": map[string]interface{}{
			"apiBase":         apiBaseURL,
			"agentId":         agentID,
			"agentToken":      agentToken,
			"topK":            5,
			"flushEveryTurns": 5,
			"flushMaxBytes":   65536,
		},
	}
}

// openclawHasEntry reports whether plugins.entries.<id> exists. We treat
// any value (even disabled:false) as "installed" — install --force is
// the user's intent to overwrite, not a uniqueness check.
func openclawHasEntry(cfg map[string]interface{}) bool {
	plugins, _ := cfg["plugins"].(map[string]interface{})
	if plugins == nil {
		return false
	}
	entries, _ := plugins["entries"].(map[string]interface{})
	if entries == nil {
		return false
	}
	_, ok := entries[OpenClawPluginID]
	return ok
}

// upsertOpenClawEntry writes:
//
//	plugins.entries.<id> = entry          (replace, preserving sibling entries)
//	plugins.slots.contextEngine = <id>    (pin our plugin as THE engine)
//	plugins.slots.memory missing → "none" (legacy memory slot off; respect
//	                                       any value the user already set)
//	plugins.allow contains <id>           (append if missing; preserve order)
//
// Any path element that exists with a non-object type is left alone and
// the call returns an error — the user must fix the config manually
// instead of having us silently destroy whatever they had there.
func upsertOpenClawEntry(cfg map[string]interface{}, entry map[string]interface{}) error {
	plugins, err := ensureObjectAt(cfg, "plugins")
	if err != nil {
		return err
	}
	entries, err := ensureObjectAt(plugins, "entries")
	if err != nil {
		return err
	}
	entries[OpenClawPluginID] = entry

	slots, err := ensureObjectAt(plugins, "slots")
	if err != nil {
		return err
	}
	slots["contextEngine"] = OpenClawPluginID
	if _, present := slots["memory"]; !present {
		slots["memory"] = "none"
	}

	allow, err := ensureStringSlice(plugins, "allow")
	if err != nil {
		return err
	}
	if !containsString(allow, OpenClawPluginID) {
		plugins["allow"] = append(allow, OpenClawPluginID)
	}
	return nil
}

func ensureObjectAt(parent map[string]interface{}, key string) (map[string]interface{}, error) {
	raw, present := parent[key]
	if !present || raw == nil {
		next := map[string]interface{}{}
		parent[key] = next
		return next, nil
	}
	next, ok := raw.(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf(
			"config has plugins.%s with type %T; expected an object — refuse to overwrite, please fix the config manually",
			key, raw)
	}
	return next, nil
}

// ensureStringSlice returns parent[key] coerced to []string when the
// value is either absent or already a JSON array of strings. A
// non-array value returns an error so we don't silently overwrite a
// user-supplied scalar.
func ensureStringSlice(parent map[string]interface{}, key string) ([]interface{}, error) {
	raw, present := parent[key]
	if !present || raw == nil {
		return []interface{}{}, nil
	}
	arr, ok := raw.([]interface{})
	if !ok {
		return nil, fmt.Errorf(
			"config has plugins.%s with type %T; expected an array — refuse to overwrite, please fix the config manually",
			key, raw)
	}
	return arr, nil
}

func containsString(arr []interface{}, target string) bool {
	for _, v := range arr {
		if s, ok := v.(string); ok && s == target {
			return true
		}
	}
	return false
}
