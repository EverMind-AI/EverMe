package conversation

import (
	"os"
	"path/filepath"
)

// Registry holds all platform scanners.
type Registry struct {
	scanners []Scanner
}

// DefaultRegistry returns a registry with every platform scanner registered.
func DefaultRegistry() *Registry {
	return &Registry{
		scanners: []Scanner{
			NewClaudeCodeScanner(),
			NewCodexScanner(),
			NewHermesScanner(),
			NewOpenClawScanner(),
			NewMarkdownScanner(),
			NewKimicodeScanner(),
			NewRavenScanner(),
			NewWorkBuddyScanner(),
		},
	}
}

// Scanners returns the list of registered scanners.
func (r *Registry) Scanners() []Scanner {
	return r.scanners
}

// ScannerFor returns the scanner for a given platform, or nil if not found.
func (r *Registry) ScannerFor(p PlatformID) Scanner {
	for _, sc := range r.scanners {
		if sc.Platform() == p {
			return sc
		}
	}
	return nil
}

// DefaultRoots returns the OS/env-resolved default scan roots for the given
// platform. Honors CLAUDE_CONFIG_DIR, CODEX_HOME per platform.
func DefaultRoots(p PlatformID) []string {
	home, _ := os.UserHomeDir()
	switch p {
	case PlatformClaudeCode:
		base := envOr("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude"))
		return []string{filepath.Join(base, "projects")}
	case PlatformCodex:
		base := envOr("CODEX_HOME", filepath.Join(home, ".codex"))
		return []string{filepath.Join(base, "sessions")}
	case PlatformHermes:
		return []string{filepath.Join(home, ".hermes", "sessions")}
	case PlatformOpenClaw:
		// The agents dir, not agents/main/sessions: OpenClaw keeps one
		// folder per agent and the scanner already walks recursively for
		// *.trajectory.jsonl, so anchoring on "main" made every other
		// agent's history invisible.
		base := envOr("OPENCLAW_CONFIG_DIR", filepath.Join(home, ".openclaw"))
		return []string{filepath.Join(base, "agents")}
	case PlatformKimicode:
		base := envOr("KIMI_CODE_HOME", filepath.Join(home, ".kimi-code"))
		return []string{filepath.Join(base, "sessions")}
	case PlatformRaven:
		// Raven hardcodes ~/.raven (raven/config/loader.py); the env
		// override is evercli's own test escape hatch, mirroring
		// cli/internal/plugin/raven.go RavenHome.
		base := envOr("EVERCLI_RAVEN_CONFIG_DIR", filepath.Join(home, ".raven"))
		return []string{filepath.Join(base, "workspace", "sessions")}
	case PlatformWorkBuddy:
		// Mirrors cli/internal/plugin/workbuddy.go workBuddyConfigDir - same
		// env var name, so the two doors into ~/.workbuddy agree.
		base := envOr("EVERCLI_WORKBUDDY_CONFIG_DIR", filepath.Join(home, ".workbuddy"))
		return []string{filepath.Join(base, "projects")}
	case PlatformMarkdown:
		// A markdown file's owning agent is the agent whose local folder
		// contains it; scan the agent home dirs (not generic doc dirs) so md
		// can be attributed and uploaded under that agent's evt.
		return []string{
			envOr("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude")),
			envOr("CODEX_HOME", filepath.Join(home, ".codex")),
			filepath.Join(home, ".hermes"),
			envOr("OPENCLAW_CONFIG_DIR", filepath.Join(home, ".openclaw")),
		}
	default:
		return nil
	}
}
