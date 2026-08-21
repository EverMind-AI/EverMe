package imports

import (
	"strings"
	"testing"

	"evercli/internal/importer/conversation"
)

// The default scan render is the compact grouped summary: it shows the
// project area + a TOTAL line, and does NOT dump per-session file paths.
func TestRenderConversationScan_GroupedByDefault(t *testing.T) {
	v := scanView{
		Items: []scanItemView{
			{Platform: "claude-code", Path: "/h/.claude/projects/-Users-me-code-app/aaa.jsonl", Date: "2026-05-18", Messages: 10},
		},
		Groups: []scanGroupView{
			{Platform: "claude-code", Area: "~/code/app", Sessions: 1, Messages: 10, DateFrom: "2026-05-18", DateTo: "2026-05-18"},
		},
	}
	out := renderConversationScan(v, false)
	if !strings.Contains(out, "AREA/PROJECT") || !strings.Contains(out, "~/code/app") {
		t.Fatalf("grouped view must show area header + project:\n%s", out)
	}
	if !strings.Contains(out, "TOTAL") {
		t.Fatalf("grouped view must show a TOTAL line:\n%s", out)
	}
	if strings.Contains(out, "aaa.jsonl") {
		t.Fatalf("grouped view must NOT dump per-session paths:\n%s", out)
	}
}

// groupScanItems collapses the per-session item list into a compact,
// consent-oriented summary: claude-code by project, markdown by owner+zone,
// flat platforms into a single "(all sessions)" row. Each group carries
// session/message counts and a date range. This is what the default scan
// preview renders so the user sees WHICH projects/areas would upload without
// scrolling hundreds of rows.
func TestGroupScanItems_ByProjectAndZone(t *testing.T) {
	items := []conversation.Item{
		// claude-code: two sessions under the same project → one group
		{Platform: "claude-code", Path: "/Users/me/.claude/projects/-Users-me-code-app/aaa.jsonl", StartedAt: "2026-05-18T10:00:00Z", MessageCount: 10},
		{Platform: "claude-code", Path: "/Users/me/.claude/projects/-Users-me-code-app/bbb.jsonl", StartedAt: "2026-06-01T10:00:00Z", MessageCount: 5},
		// claude-code: different project → separate group
		{Platform: "claude-code", Path: "/Users/me/.claude/projects/-Users-me-code-other/ccc.jsonl", StartedAt: "2026-06-10T10:00:00Z", MessageCount: 7},
		// codex: flat → single "(all sessions)" group
		{Platform: "codex", Path: "/Users/me/.codex/sessions/x.jsonl", StartedAt: "2026-06-05T10:00:00Z", MessageCount: 3},
		{Platform: "codex", Path: "/Users/me/.codex/sessions/y.jsonl", StartedAt: "2026-06-06T10:00:00Z", MessageCount: 4},
		// markdown: persona (depth-1) vs memory subtree, attributed to openclaw
		{Platform: "markdown", Path: "/Users/me/.openclaw/workspace/USER.md", OwnerPlatform: "openclaw", UpdatedAt: "2026-03-18T10:00:00Z", MessageCount: 1},
		{Platform: "markdown", Path: "/Users/me/.openclaw/workspace/memory/2026-04-04.md", OwnerPlatform: "openclaw", UpdatedAt: "2026-04-04T10:00:00Z", MessageCount: 1},
	}

	groups := groupScanItems(items)

	// Index by platform+area for assertions.
	byKey := map[string]scanGroupView{}
	for _, g := range groups {
		byKey[g.Platform+"|"+g.Area] = g
	}

	if len(groups) != 5 {
		t.Fatalf("expected 5 groups, got %d: %+v", len(groups), groups)
	}

	app, ok := byKey["claude-code|~/code/app"]
	if !ok {
		t.Fatalf("expected decoded claude-code project group ~/code/app; groups=%+v", groups)
	}
	if app.Sessions != 2 || app.Messages != 15 {
		t.Errorf("app group: want 2 sessions/15 msgs, got %d/%d", app.Sessions, app.Messages)
	}
	if app.DateFrom != "2026-05-18" || app.DateTo != "2026-06-01" {
		t.Errorf("app group date range: want 2026-05-18→2026-06-01, got %s→%s", app.DateFrom, app.DateTo)
	}

	codex, ok := byKey["codex|(all sessions)"]
	if !ok || codex.Sessions != 2 || codex.Messages != 7 {
		t.Errorf("codex group: want 2 sessions/7 msgs in '(all sessions)', got %+v (ok=%v)", codex, ok)
	}

	if _, ok := byKey["markdown|openclaw:persona"]; !ok {
		t.Errorf("expected markdown persona group; groups=%+v", groups)
	}
	if _, ok := byKey["markdown|openclaw:memory/notes"]; !ok {
		t.Errorf("expected markdown memory/notes group; groups=%+v", groups)
	}
}
