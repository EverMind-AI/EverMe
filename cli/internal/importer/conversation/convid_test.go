package conversation

import "testing"

func TestConversationIDStableOnOrigin(t *testing.T) {
	a := ConversationID(PlatformClaudeCode, "sess-123", "/x/y.jsonl")
	b := ConversationID(PlatformClaudeCode, "sess-123", "/x/y.jsonl")
	if a != b || a == "" {
		t.Fatalf("must be stable & non-empty: %q %q", a, b)
	}
	// no origin id -> falls back to path hash, still stable
	c := ConversationID(PlatformCodex, "", "/a/b.jsonl")
	d := ConversationID(PlatformCodex, "", "/a/b.jsonl")
	if c != d || c == "" {
		t.Fatalf("path-hash fallback must be stable: %q %q", c, d)
	}
	if a == c {
		t.Fatalf("different inputs must differ")
	}
}
