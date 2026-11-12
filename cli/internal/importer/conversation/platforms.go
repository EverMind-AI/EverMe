package conversation

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// knownPlatforms is the canonical set of platform names accepted on the
// command line and in DefaultRegistry.
var knownPlatforms = map[PlatformID]struct{}{
	PlatformClaudeCode: {},
	PlatformCodex:      {},
	PlatformHermes:     {},
	PlatformOpenClaw:   {},
	PlatformMarkdown:   {},
	PlatformKimicode:   {},
	PlatformRaven:      {},
	PlatformWorkBuddy:  {},
	PlatformSeekMoon:   {},
}

// PlatformList renders the known platform names for CLI hints. Callers use it
// instead of repeating the list, so a new platform cannot be accepted by
// ParsePlatforms while the hint still tells the user it does not exist.
func PlatformList() string {
	names := make([]string, 0, len(knownPlatforms))
	for p := range knownPlatforms {
		names = append(names, string(p))
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}

// IsKnownPlatform reports whether p is one of the supported platform names.
func IsKnownPlatform(p PlatformID) bool {
	_, ok := knownPlatforms[p]
	return ok
}

// ParsePlatforms trims and validates the requested platform names, returning
// an error naming the first unknown one. Callers surface this as an
// invalid-argument error.
func ParsePlatforms(names []string) ([]PlatformID, error) {
	ids := make([]PlatformID, 0, len(names))
	for _, n := range names {
		p := PlatformID(strings.TrimSpace(n))
		if !IsKnownPlatform(p) {
			return nil, fmt.Errorf("unknown platform %q (known: %s)", n, PlatformList())
		}
		ids = append(ids, p)
	}
	return ids, nil
}

// agentHomeDirs returns the resolved home directory for each agent platform,
// honoring the same env overrides as DefaultRoots / platformEnvFile. Used to
// attribute a markdown file to the agent whose folder contains it.
func agentHomeDirs() map[PlatformID]string {
	home, _ := os.UserHomeDir()
	return map[PlatformID]string{
		PlatformClaudeCode: envOr("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude")),
		PlatformCodex:      envOr("CODEX_HOME", filepath.Join(home, ".codex")),
		PlatformHermes:     filepath.Join(home, ".hermes"),
		PlatformOpenClaw:   envOr("OPENCLAW_CONFIG_DIR", filepath.Join(home, ".openclaw")),
	}
}

// ownerForMarkdownPath returns the agent platform whose home dir contains the
// given path (prefix match), or "" if the path is under none of them.
func ownerForMarkdownPath(path string) PlatformID {
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	abs = filepath.Clean(abs)
	for p, dir := range agentHomeDirs() {
		dir = filepath.Clean(dir)
		if abs == dir {
			return p
		}
		if strings.HasPrefix(abs, dir+string(os.PathSeparator)) {
			return p
		}
	}
	return ""
}

// AttributionPlatform returns the platform whose evt should be used to upload
// the item: for an owned markdown file, its owning agent; otherwise the item's
// own platform.
func AttributionPlatform(item Item) PlatformID {
	if item.Platform == PlatformMarkdown && item.OwnerPlatform != "" {
		return item.OwnerPlatform
	}
	return item.Platform
}
