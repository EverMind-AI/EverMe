package imports

import (
	"regexp"
	"sort"
	"strings"

	"evercli/internal/importer/conversation"
)

// scanGroupView is one row of the compact, consent-oriented scan summary:
// sessions collapsed by their natural container (claude-code → project,
// markdown → owner:zone, flat platforms → a single "(all sessions)" row).
type scanGroupView struct {
	Platform string `json:"platform"`
	Area     string `json:"area"`
	Sessions int    `json:"sessions"`
	Messages int    `json:"messages"`
	DateFrom string `json:"dateFrom,omitempty"`
	DateTo   string `json:"dateTo,omitempty"`
}

var (
	ccProjectRe = regexp.MustCompile(`/projects/([^/]+)/`)
	// homePrefixRe abbreviates a decoded absolute path to ~/... regardless of
	// the actual user, so the displayed location is stable and approximate.
	homePrefixRe = regexp.MustCompile(`^/(?:Users|home)/[^/]+/`)
)

// scanGroupArea returns the grouping area for an item: the (approximate)
// project location for claude-code, owner:zone for markdown, and a single
// bucket for the flat session platforms.
func scanGroupArea(it conversation.Item) string {
	switch it.Platform {
	case conversation.PlatformClaudeCode:
		return decodeProjectArea(it.Path)
	case conversation.PlatformMarkdown:
		owner := string(it.OwnerPlatform)
		if owner == "" {
			owner = "?"
		}
		zone := "persona"
		lp := strings.ToLower(it.Path)
		if strings.Contains(lp, "/memory/") || strings.Contains(lp, "/memories/") {
			zone = "memory/notes"
		}
		return owner + ":" + zone
	default:
		return "(all sessions)"
	}
}

// decodeProjectArea turns a Claude Code project session path into an
// approximate, human-readable project location. Claude Code encodes the
// project's absolute path by replacing "/" with "-"; we reverse that (a
// best-effort approximation — literal dashes in names are not recoverable)
// and abbreviate the home prefix to "~/".
func decodeProjectArea(path string) string {
	m := ccProjectRe.FindStringSubmatch(path)
	if m == nil {
		return "(root)"
	}
	dec := strings.ReplaceAll(m[1], "-", "/")
	dec = homePrefixRe.ReplaceAllString(dec, "~/")
	return dec
}

// groupScanItems collapses per-session items into the compact summary,
// returned in a deterministic order (platform, then area).
func groupScanItems(items []conversation.Item) []scanGroupView {
	type acc struct {
		sessions, messages int
		dmin, dmax         string
	}
	m := map[string]*acc{}
	for _, it := range items {
		key := string(it.Platform) + "|" + scanGroupArea(it)
		a := m[key]
		if a == nil {
			a = &acc{}
			m[key] = a
		}
		a.sessions++
		a.messages += it.MessageCount
		d := it.StartedAt
		if d == "" {
			d = it.UpdatedAt
		}
		if len(d) >= 10 {
			d = d[:10]
			if a.dmin == "" || d < a.dmin {
				a.dmin = d
			}
			if a.dmax == "" || d > a.dmax {
				a.dmax = d
			}
		}
	}

	groups := make([]scanGroupView, 0, len(m))
	for key, a := range m {
		parts := strings.SplitN(key, "|", 2)
		groups = append(groups, scanGroupView{
			Platform: parts[0],
			Area:     parts[1],
			Sessions: a.sessions,
			Messages: a.messages,
			DateFrom: a.dmin,
			DateTo:   a.dmax,
		})
	}
	sort.Slice(groups, func(i, j int) bool {
		if groups[i].Platform != groups[j].Platform {
			return groups[i].Platform < groups[j].Platform
		}
		return groups[i].Area < groups[j].Area
	})
	return groups
}
