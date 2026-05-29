package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"evercli/internal/output"
)

// mcpEntryName is the key under "mcpServers" that EverMe owns. Stable
// across all platforms — both Claude Code and OpenClaw read MCP config
// in this shape.
const mcpEntryName = "everme-memory"

// backupSuffix is the fixed-form sentinel appended to the timestamped
// backup name. We keep at most ONE backup per config path: the most
// recent pre-install state. The previous "rotate up to 5" policy was
// retired in the slimming pass — disk pressure was hypothetical and
// users who really want history can rely on Time Machine / git.
const backupSuffix = "-bak"

// mcpWriter is the Writer implementation for hosts whose plugin slot is
// an MCP-server map. Today that's only Claude Code (top-level
// `mcpServers.<name>` in ~/.claude.json); OpenClaw moved to an
// in-process context-engine plugin and owns its own writer in
// openclaw.go. The path is still parameterised so a future MCP-style
// host can drop in with just a new path constant.
type mcpWriter struct {
	platform    Platform
	serversPath []string // map keys to walk to reach the servers map
}

// claudeCodeServersPath is exported as a package var so future
// detectors / tests can reuse it.
var claudeCodeServersPath = []string{"mcpServers"}

func newMCPWriter(p Platform) *mcpWriter {
	return &mcpWriter{platform: p, serversPath: claudeCodeServersPath}
}

func (m *mcpWriter) Platform() Platform { return m.platform }

// Plan validates the target path: parent directory writable, file
// parses as JSON if it exists. Captures whether we'll create or replace,
// and stages the BackupPath name (so Commit doesn't have to reason about
// timestamps mid-flight).
func (m *mcpWriter) Plan(_ context.Context, configPath string) (*WritePlan, error) {
	if configPath == "" {
		return nil, output.Invalid("configPath is required", "")
	}
	abs, err := filepath.Abs(configPath)
	if err != nil {
		return nil, output.IOErr(configPath, "abs-path", err)
	}

	plan := &WritePlan{Platform: m.platform, ConfigPath: abs}

	// Parent dir must exist or be creatable.
	parent := filepath.Dir(abs)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return nil, output.IOErr(parent, "mkdir-parent", err)
	}

	cfg, exists, err := readConfig(abs)
	if err != nil {
		return nil, err
	}
	plan.WillCreate = !exists
	plan.WillReplace = nestedMcpServersHasEntry(cfg, m.serversPath, mcpEntryName)
	if exists {
		// One backup per config path, overwriting the prior one on
		// re-install. The previous nanosecond-precision rotating
		// filename was retired in the slimming pass — disk pressure
		// from many backups was hypothetical and the surrounding
		// machinery (pruneBackups + maxBackups + regex) was the
		// expensive part. Same-second re-installs now overwrite the
		// previous backup; users who need history rely on Time
		// Machine / git / their own snapshots.
		plan.BackupPath = abs + backupSuffix
		// Snapshot mtime+size for the C3 TOCTOU check at Commit.
		if info, statErr := os.Stat(abs); statErr == nil {
			plan.SnapshotModTime = info.ModTime().UnixNano()
			plan.SnapshotSize = info.Size()
		}
	}

	// Build a preview of what Commit would write. Token is masked
	// because Plan is also fed to --dry-run output.
	plan.PreviewEntry = buildEntry("https://api.everme.evermind.ai", "agt_<assigned-on-commit>", "evt_<assigned-on-commit>")
	return plan, nil
}

// Commit applies the plan: re-read (in case anything changed since
// Plan), upsert the entry, atomic rename. The backend has already
// minted AgentToken at this point — failures from here surface a hint
// telling the user to re-run install (the old evt is gone either way).
func (m *mcpWriter) Commit(_ context.Context, plan *WritePlan, params WriteParams) (*WriteResult, error) {
	if plan == nil {
		return nil, output.Internal(fmt.Errorf("nil plan"))
	}

	// C3 TOCTOU: refuse to overwrite when the file changed or appeared
	// since Plan. Shared helper so claude_code.go's env-file writer and
	// this JSON writer enforce the same invariant.
	if err := assertNoConcurrentChange(plan); err != nil {
		return nil, err
	}

	cfg, exists, err := readConfig(plan.ConfigPath)
	if err != nil {
		return nil, err
	}

	// Backup before mutating, but only if the file existed at Plan
	// time AND still exists now. If the user removed it between Plan
	// and Commit, we just create fresh.
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
	if upErr := nestedMcpUpsertEntry(cfg, m.serversPath, mcpEntryName, buildEntry(params.APIBaseURL, params.AgentID, params.AgentToken)); upErr != nil {
		return nil, output.Invalid(
			fmt.Sprintf("config at %s has a shape collision under mcp.*: %v", plan.ConfigPath, upErr),
			"Fix the config file's shape manually (an mcp.* path collides with an unexpected non-object value), then retry install",
		)
	}

	if err := writeConfigAtomic(plan.ConfigPath, cfg); err != nil {
		return nil, err
	}

	return &WriteResult{
		Platform:      m.platform,
		ConfigPath:    plan.ConfigPath,
		BackupPath:    wroteBackup,
		WroteNewEntry: !plan.WillReplace,
	}, nil
}

// ---- helpers ---------------------------------------------------------

// readConfig parses the JSON config at path. Returns (cfg, exists, err).
// Missing file → (nil, false, nil); malformed JSON → IO error so the
// user knows to fix it manually rather than have us silently overwrite.
func readConfig(path string) (map[string]interface{}, bool, error) {
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
	if err := json.Unmarshal(raw, &cfg); err != nil {
		ce := output.IOErr(path, "parse-json", err)
		ce.Hint = "Config is not valid JSON; fix it manually before re-running"
		return nil, true, ce
	}
	return cfg, true, nil
}

// writeConfigAtomic writes cfg to path via .tmp + rename, forcing 0600
// because the file carries a freshly-minted evt token. We deliberately
// tighten a pre-existing 0644 ~/.claude.json — a world-readable token
// is the worse surprise.
//
// On rename failure we delete the orphaned .tmp — it would otherwise
// linger on disk containing the freshly minted evt token.
func writeConfigAtomic(path string, cfg map[string]interface{}) error {
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return output.Internal(fmt.Errorf("marshal config: %w", err))
	}

	if err := writeFileAtomic(path, raw, 0o600); err != nil {
		return output.IOErr(path, "write-config", err)
	}
	return nil
}

// writeFileAtomic writes `body` to `path` via .tmp + fsync + rename,
// applying `mode` on creation. The token-bearing files this powers
// (~/.claude/everme.env, ~/.claude.json, ~/.openclaw/openclaw.json)
// hold the freshly-minted evt; a crash between `Write` and `Rename`
// must not leave a torn or zero-byte file the next plugin startup
// would read as the canonical version.
//
// We explicitly remove a stale `.tmp` first because `os.WriteFile`
// uses `O_CREATE|O_TRUNC` (which is a no-op for perms when the file
// already exists) — without this dance, an orphaned `.tmp` left from
// a previous crash with mode 0644 would keep its 0644 perm, and the
// freshly minted evt token would land in a world-readable file
// before rename. Both env files (claude_code.go) and JSON configs
// (mcp.go) flow through here so the property holds uniformly.
//
// On any failure we delete the orphaned .tmp — it contains the new
// token.
func writeFileAtomic(path string, body []byte, mode os.FileMode) error {
	tmp := path + ".tmp"
	// Best-effort remove: if .tmp doesn't exist we just proceed.
	_ = os.Remove(tmp)
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	if _, err := f.Write(body); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	// fsync the data file before rename so a crash between Rename and
	// the OS flush can't surface a zero-byte file at `path` next read.
	// Matches the credential / auth atomic-write path.
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	// fsync the parent directory so the rename hits stable storage.
	// Best-effort: directory fsync isn't supported on all filesystems
	// (overlayfs, certain Windows configurations) — the missing flush
	// is acceptable, the missing TRY is not.
	if dir, dirErr := os.Open(filepath.Dir(path)); dirErr == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}

// assertNoConcurrentChange enforces the C3 TOCTOU invariant: the file
// state captured at Plan time must match the state at Commit time. If
// Plan saw an existing file we refuse to overwrite when (mtime, size)
// has shifted (concurrent edit by Claude Code's app, another evercli,
// or a manual save). If Plan saw no file we refuse when one has
// appeared (concurrent create by another writer). Used by every
// Writer.Commit so the freshly minted evt never lands on top of work
// the user / another tool just produced.
func assertNoConcurrentChange(plan *WritePlan) error {
	if plan.SnapshotModTime != 0 {
		info, statErr := os.Stat(plan.ConfigPath)
		if statErr == nil &&
			(info.ModTime().UnixNano() != plan.SnapshotModTime ||
				info.Size() != plan.SnapshotSize) {
			ce := output.IOErr(plan.ConfigPath, "concurrent-edit", fmt.Errorf(
				"config was modified between Plan and Commit (mtime/size changed)"))
			ce.Hint = "Another process edited the file; re-run `evercli plugin install` to re-plan against the latest content"
			return ce
		}
	}
	if plan.WillCreate {
		if _, statErr := os.Stat(plan.ConfigPath); statErr == nil {
			ce := output.IOErr(plan.ConfigPath, "concurrent-create", fmt.Errorf(
				"config did not exist at Plan time but appeared before Commit"))
			ce.Hint = "Another process created the file; re-run `evercli plugin install` so we merge into the new content instead of overwriting it"
			return ce
		}
	}
	return nil
}

// nestedMcpServersHasEntry reports whether the servers map at the given
// path contains `name`. path is the chain of keys to walk into, e.g.
// {"mcpServers"} (Claude Code) or {"mcp", "servers"} (OpenClaw).
func nestedMcpServersHasEntry(cfg map[string]interface{}, path []string, name string) bool {
	servers := walkServersMap(cfg, path)
	if servers == nil {
		return false
	}
	_, ok := servers[name]
	return ok
}

// nestedMcpUpsertEntry sets cfg<path>[name] = entry, creating any
// missing parent maps. Sibling keys are preserved verbatim. Returns
// an error if any path element exists with a non-map type — see
// ensureServersMap for the rationale (refuse to silently destroy
// user data).
func nestedMcpUpsertEntry(cfg map[string]interface{}, path []string, name string, entry map[string]interface{}) error {
	servers, err := ensureServersMap(cfg, path)
	if err != nil {
		return err
	}
	servers[name] = entry
	return nil
}

// walkServersMap returns cfg<path> if every step is a map, else nil.
func walkServersMap(cfg map[string]interface{}, path []string) map[string]interface{} {
	current := cfg
	for _, key := range path {
		if current == nil {
			return nil
		}
		next, ok := current[key].(map[string]interface{})
		if !ok {
			return nil
		}
		current = next
	}
	return current
}

// ensureServersMap walks cfg<path>, creating any missing intermediate
// maps. The returned map is the servers map itself — callers mutate it
// directly to upsert entries.
//
// SAFETY: if any intermediate key already exists with a
// non-map JSON type (string, number, list, bool, null), we return an
// error rather than silently overwriting it with `{}`. The previous
// silent-overwrite behaviour could destroy user data — e.g. an
// openclaw.json with `"mcp": []` (legal JSON, even if an unusual
// shape) would have its `[]` replaced by `{servers: {...}}`, losing
// whatever the user had there. Now Plan/Commit fail-fast and the user
// is told to fix the config manually before retrying.
func ensureServersMap(cfg map[string]interface{}, path []string) (map[string]interface{}, error) {
	current := cfg
	for i, key := range path {
		raw, present := current[key]
		if !present || raw == nil {
			next := map[string]interface{}{}
			current[key] = next
			current = next
			continue
		}
		next, ok := raw.(map[string]interface{})
		if !ok {
			return nil, fmt.Errorf(
				"config has %s with type %T; expected an object — refuse to overwrite, please fix the config manually",
				strings.Join(path[:i+1], "."), raw)
		}
		current = next
	}
	return current, nil
}

// buildEntry produces the canonical everme-memory entry. Centralised so
// future changes (additional env vars, new args) propagate everywhere.
//
// Cross-platform note: on Windows, `npx` is a shim batch file named
// `npx.cmd`. Some MCP hosts (Claude Code on Windows, certain shell
// spawn helpers) cannot resolve a bare "npx" without the .cmd
// extension because they don't apply PATHEXT. Emit the platform-
// appropriate name so the entry runs on the host's machine.
//
// We do NOT validate the apiBaseURL / agentToken shapes here — the
// values come from the freshly-loaded Config (which validates at load
// time) and the freshly-minted backend response. Callers that pass
// previewed placeholder values (`agt_<assigned-on-commit>`) need this
// helper to remain shape-tolerant.
func buildEntry(apiBaseURL, agentID, agentToken string) map[string]interface{} {
	return map[string]interface{}{
		"command": npxCommand(),
		"args":    []interface{}{"-y", "@everme/memory-mcp"},
		"env": map[string]interface{}{
			"EVERME_API_BASE":    apiBaseURL,
			"EVERME_AGENT_ID":    agentID,
			"EVERME_AGENT_TOKEN": agentToken,
		},
	}
}

// npxCommand returns "npx.cmd" on Windows, "npx" elsewhere. Tests
// stubbing GOOS = "windows" can flip the behaviour by overriding
// runtimeGOOS.
func npxCommand() string {
	if runtimeGOOS() == "windows" {
		return "npx.cmd"
	}
	return "npx"
}
