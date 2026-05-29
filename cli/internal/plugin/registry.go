package plugin

import (
	"context"
	"sort"
)

// registry is the central catalogue of supported platforms. Tests inject
// their own via NewServiceWithRegistry, but production code goes through
// DefaultRegistry which carries the V1 install matrix (Claude Code +
// OpenClaw + Cursor + Claude Desktop + Codex + Hermes). Windsurf /
// VS Code Copilot / Cline are V1.1 candidates. A V2 Hermes track —
// native Python MemoryProvider via `pip install everme-hermes` — is
// deferred and orthogonal to the V1.x MCP path landed in hermes.go.
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
//   - PlatformCursor / PlatformClaudeDesktop → mcpWriter
//     Both hosts read MCP servers from a top-level `mcpServers.<name>`
//     JSON map, so the writer is the shared mcpWriter parameterised by
//     platform. Only the config file location is host-specific (see
//     cursor.go / claude_desktop.go).
//
//   - PlatformCodex → codexWriter
//     Codex App + Codex CLI both consume ~/.codex/config.toml, so a
//     single install covers both. codexWriter implements Preparer
//     (marketplace add, BEFORE token mint) and Verifier (post-commit
//     re-parse). See codex.go.
//
//   - PlatformHermes → hermesWriter
//     Hermes (Python) reads MCP servers from `mcp_servers.<name>` in
//     ~/.hermes/config.yaml. hermesWriter upserts `mcp_servers.everme`
//     directly via yaml.v3 — same on-disk effect as Hermes's own
//     `_save_mcp_server(name, dict)` catalog-install helper. We do
//     NOT shell out to `hermes mcp add` because its argparse can't
//     carry dash-leading args (`-y` for npx), confirmed against
//     Hermes v0.14.0. Implements Verifier (re-read mcp_servers.everme)
//     but not Preparer — Hermes has no marketplace concept. See
//     hermes.go.
func DefaultRegistry() *registry {
	return &registry{
		detectors: map[Platform]Detector{
			PlatformClaudeCode:    claudeCodeDetector{},
			PlatformOpenClaw:      openclawDetector{},
			PlatformCursor:        cursorDetector{},
			PlatformClaudeDesktop: claudeDesktopDetector{},
			PlatformCodex:         codexDetector{},
			PlatformHermes:        hermesDetector{},
		},
		writers: map[Platform]Writer{
			PlatformClaudeCode:    newClaudeCodeWriter(),
			PlatformOpenClaw:      newOpenClawWriter(),
			PlatformCursor:        newCursorWriter(),
			PlatformClaudeDesktop: newClaudeDesktopWriter(),
			PlatformCodex:         newCodexWriter(),
			PlatformHermes:        newHermesWriter(),
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
