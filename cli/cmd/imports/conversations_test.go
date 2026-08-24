package imports

import (
	"strings"
	"testing"
	"time"
)

func TestEffectiveSessionTimeout(t *testing.T) {
	cases := []struct {
		in, want time.Duration
	}{
		{0, 0},                              // unlimited stays unlimited
		{-1, -1},                            // defensive: non-positive untouched
		{30 * time.Second, 5 * time.Minute}, // short global timeout is floored
		{5 * time.Minute, 5 * time.Minute},
		{10 * time.Minute, 10 * time.Minute},
	}
	for _, c := range cases {
		if got := effectiveSessionTimeout(c.in); got != c.want {
			t.Errorf("effectiveSessionTimeout(%v)=%v, want %v", c.in, got, c.want)
		}
	}
}

func TestIsExtractionDeferred(t *testing.T) {
	cases := []struct {
		status string
		want   bool
	}{
		{"extraction_pending", true},
		{"submitted", false},
		{"", false},
		{"EXTRACTION_PENDING", false}, // exact match only, no case-folding
	}
	for _, c := range cases {
		if got := isExtractionDeferred(c.status); got != c.want {
			t.Errorf("isExtractionDeferred(%q)=%v, want %v", c.status, got, c.want)
		}
	}
}

func TestRenderScanShowsPathDateAndPrivacy(t *testing.T) {
	out := renderConversationScan(scanView{
		Items: []scanItemView{{Platform: "claude-code", Path: "/h/.claude/projects/p/s.jsonl", Date: "2026-05-01", Messages: 12, ToolCalls: 8}},
	}, true)
	if !strings.Contains(out, "/h/.claude/projects/p/s.jsonl") || !strings.Contains(out, "2026-05-01") {
		t.Fatalf("must show path + date:\n%s", out)
	}
	if !strings.Contains(out, "隐私") && !strings.Contains(strings.ToLower(out), "privacy") {
		t.Fatalf("must show privacy warning:\n%s", out)
	}
}

func TestRenderScanShowsNotFoundHint(t *testing.T) {
	out := renderConversationScan(scanView{
		Items: nil,
		NotFound: map[string]string{
			"codex": "directory not found for codex",
		},
	}, false)
	if !strings.Contains(out, "codex") {
		t.Fatalf("must show not-found hint:\n%s", out)
	}
}

func TestRenderScanShowsMultipleItems(t *testing.T) {
	out := renderConversationScan(scanView{
		Items: []scanItemView{
			{Platform: "claude-code", Path: "/a/sess1.jsonl", Date: "2026-05-01", Messages: 5, ToolCalls: 2},
			{Platform: "codex", Path: "/b/sess2.jsonl", Date: "2026-05-15", Messages: 10, ToolCalls: 3},
		},
	}, true)
	if !strings.Contains(out, "/a/sess1.jsonl") || !strings.Contains(out, "/b/sess2.jsonl") {
		t.Fatalf("must show both items:\n%s", out)
	}
	if !strings.Contains(out, "2026-05-01") || !strings.Contains(out, "2026-05-15") {
		t.Fatalf("must show both dates:\n%s", out)
	}
}
