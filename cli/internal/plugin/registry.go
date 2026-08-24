package plugin

import (
	"context"
	"sort"
)

// registry is the central catalogue of supported platforms. Tests inject
// their own via NewServiceWithRegistry, but production code goes through
// DefaultRegistry which carries the V1 install matrix (Claude Code +
// OpenClaw + Cursor + Claude Desktop + Codex + Hermes +
// Devin + WorkBuddy + opencode). VS Code Copilot / Cline remain future candidates.
type registry struct {
	detectors map[Platform]Detector
	writers   map[Platform]Writer
}

// DefaultRegistry returns a fresh registry populated with the production
// platform set. Each call returns a new map so tests can mutate freely.
//
// Per-host writer selection (no historical baggage now that nothing's
// published — each agent gets the path that lives best for it):
//
//   - PlatformClaudeCode → claudeCodeWriter
//     calls `claude plugin install @everme/claude-code` and writes
//     ~/.claude/everme.env. The user gets hooks (SessionStart /
//     UserPromptSubmit / Stop / SessionEnd), commands (`/recall`),
//     skill (memory-tools), AND the bundled MCP server — i.e. the
//     full Claude Code-native experience, not just an MCP shim.
//
//   - PlatformOpenClaw → openclawWriter
//     OpenClaw loads our context-engine plugin in-process from
//     plugins.entries.<id>; the writer pins the slot binding,
//     allow-list and config (apiBase + freshly minted agent_token).
//     The plugin source is installed separately via
//     `openclaw plugins install @everme/openclaw`.
//
//   - PlatformCursor / PlatformDevin → nativeHookWriter
//     Each host receives the shared MCP entry plus native lifecycle hooks and
//     a protected everme.env file; Cursor and Devin use separate hook configs.
//
//   - PlatformClaudeDesktop / PlatformWorkBuddy → mcpWriter
//     These MCP-only hosts use the shared JSON writer.
//
//   - PlatformOpenCode → opencodeWriter
//     opencode reads MCP servers from a top-level `mcp.<name>` map in
//     ~/.config/opencode/opencode.json, but with a divergent entry shape
//     (type:"local", command argv array, `environment` not `env`,
//     enabled). A small custom writer reuses mcp.go's JSON / atomic-write
//     / TOCTOU / upsert helpers. Install-only (no Preparer/Verifier). See
//     opencode.go.
//
//   - PlatformCodex → codexWriter
//     Codex App + Codex CLI both consume ~/.codex/config.toml, so a
//     single install covers both. codexWriter implements Preparer
//     (marketplace add, BEFORE token mint) and Verifier (post-commit
//     re-parse). See codex.go.
//
//   - PlatformHermes → hermesWriter
//     Hermes (Python) supports native MemoryProviders under
//     $HERMES_HOME/plugins/<name>/. hermesWriter installs the embedded
//     EverMe provider there, writes everme.env (0600), sets
//     memory.provider=everme, and removes any legacy mcp_servers.everme
//     entry. Memory capture is hook-driven (sync_turn / on_session_end),
//     not dependent on model-initiated tool calls. Implements Verifier
//     (provider files + memory.provider) but not Preparer. See hermes.go.
//
//   - PlatformRaven → ravenWriter
//     Raven (Python) discovers external plugins from
//     ~/.raven/plugins/<id>/raven-plugin.toml and binds one memory
//     backend via config.json memory.backend (single slot). ravenWriter
//     drops the embedded EverMe MemoryBackend there and patches
//     config.json (memory.backend=everme + plugins.config credentials —
//     Raven's config.json is its canonical credential store, so no env
//     file). Memory capture is host-driven (recall before turn / store
//     after turn), not dependent on model-initiated tool calls.
//     Implements Verifier (plugin manifest + memory.backend) but not
//     Preparer. See raven.go.
//
//   - PlatformDSH → dshWriter
//     DeepSeek Harness loads @deepseek-ai/dsh-mcp-client from
//     ~/.dsh/cordis.patch.yml. dshWriter owns a reversible patch block and
//     a protected ~/.dsh/.env credential block because DSH scrubs inherited
//     credential-shaped variables before spawning stdio MCP servers.
//     Implements Preparer, Verifier and Remover. See dsh.go.
func DefaultRegistry() *registry {
	return &registry{
		detectors: map[Platform]Detector{
			PlatformClaudeCode:    claudeCodeDetector{},
			PlatformOpenClaw:      openclawDetector{},
			PlatformCursor:        cursorDetector{},
			PlatformClaudeDesktop: claudeDesktopDetector{},
			PlatformCodex:         codexDetector{},
			PlatformHermes:        hermesDetector{},
			PlatformDevin:         devinDetector{},
			PlatformWorkBuddy:     workBuddyDetector{},
			PlatformOpenCode:      opencodeDetector{},
			PlatformKimiCode:      kimiCodeDetector{},
			PlatformRaven:         ravenDetector{},
			PlatformDSH:           dshDetector{},
		},
		writers: map[Platform]Writer{
			PlatformClaudeCode:    newClaudeCodeWriter(),
			PlatformOpenClaw:      newOpenClawWriter(),
			PlatformCursor:        newCursorWriter(),
			PlatformClaudeDesktop: newClaudeDesktopWriter(),
			PlatformCodex:         newCodexWriter(),
			PlatformHermes:        newHermesWriter(),
			PlatformDevin:         newDevinWriter(),
			PlatformWorkBuddy:     newWorkBuddyWriter(),
			PlatformOpenCode:      newOpenCodeWriter(),
			PlatformKimiCode:      newKimiCodeWriter(),
			PlatformRaven:         newRavenWriter(),
			PlatformDSH:           newDSHWriter(),
		},
	}
}

// SupportedPlatforms returns the registered platform names in alphabetic
// order. cmd uses this for `--help` rendering and error messages.
func (r *registry) SupportedPlatforms() []Platform {
	out := make([]Platform, 0, len(r.detectors))
	for p := range r.detectors {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// Has reports whether the platform is registered. Used to validate
// user-supplied --platform args before any further work.
func (r *registry) Has(p Platform) bool {
	_, ok := r.detectors[p]
	return ok
}

func (r *registry) detector(p Platform) Detector { return r.detectors[p] }
func (r *registry) writer(p Platform) Writer     { return r.writers[p] }

// Detect is a thin wrapper for callers (notably internal/doctor) that
// only need a one-off detection result without going through Service.
// Returns (nil, nil) when the platform isn't registered — convenient
// for "ask about everything in SupportedPlatforms" loops.
func (r *registry) Detect(ctx context.Context, p Platform) (*Detection, error) {
	d, ok := r.detectors[p]
	if !ok {
		return nil, nil
	}
	return d.Detect(ctx)
}
