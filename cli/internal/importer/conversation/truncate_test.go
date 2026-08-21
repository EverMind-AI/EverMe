package conversation

import (
	"os"
	"strings"
	"testing"
	"unicode/utf8"
)

// The server rejects any message whose content exceeds 8000 runes
// (utf8.RuneCountInString(s) > 8000 → HTTP 400). Truncation must therefore
// produce output whose TOTAL rune count (content slice + marker) is ≤ the
// cap — reserving room for the marker, not appending it on top of a full
// cap-sized slice (which overshoots to cap+markerLen and gets rejected).
func TestTruncateRunesCCStaysWithinCapIncludingMarker(t *testing.T) {
	const cap = 8000
	in := strings.Repeat("世", 10000) // 10k multibyte runes, well over cap
	out := truncateRunesCC(in, cap)
	if n := utf8.RuneCountInString(out); n > cap {
		t.Fatalf("truncated output must be <= %d runes (server cap), got %d", cap, n)
	}
	if !strings.Contains(out, "evercli import") {
		t.Fatal("truncated output must keep the truncation marker")
	}
}

// Truncation keeps HEAD and TAIL (middle-out, head_ratio 0.7) — mirroring the
// server extractor's _truncate_text, so the start (command/intent) AND the end
// (final result/conclusion, which the case extractor mines) both survive into
// the <=cap payload instead of head-only clipping that drops the tail.
func TestTruncateRunesCCKeepsHeadAndTail(t *testing.T) {
	const cap = 8000
	const headMark = "HEAD_SENTINEL_BEGIN"
	const tailMark = "TAIL_SENTINEL_END"
	in := headMark + strings.Repeat("x", 25000) + tailMark

	out := truncateRunesCC(in, cap)

	if n := utf8.RuneCountInString(out); n > cap {
		t.Fatalf("output must be <= %d runes, got %d", cap, n)
	}
	if !strings.Contains(out, headMark) {
		t.Errorf("head must be preserved")
	}
	if !strings.Contains(out, tailMark) {
		t.Errorf("tail must be preserved (head+tail truncation, not head-only)")
	}
	if !strings.Contains(out, "trimmed") {
		t.Errorf("expected a middle-trim marker")
	}
	// head_ratio 0.7 → head segment materially larger than tail segment.
	mid := strings.Index(out, "trimmed")
	if mid <= 0 {
		t.Fatal("marker not found")
	}
	headLen := utf8.RuneCountInString(out[:mid])
	tailLen := utf8.RuneCountInString(out[mid:])
	if headLen <= tailLen {
		t.Errorf("head_ratio 0.7 should make head longer than tail, got head=%d tail=%d", headLen, tailLen)
	}
}

// Markdown uses its own inline truncation; it has the same cap obligation.
func TestMarkdownReadStaysWithinCap(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/big.md"
	if err := os.WriteFile(path, []byte(strings.Repeat("世", 10000)), 0o644); err != nil {
		t.Fatal(err)
	}
	conv, err := NewMarkdownScanner().Read(Item{Platform: PlatformMarkdown, Path: path})
	if err != nil {
		t.Fatal(err)
	}
	s, _ := conv.Messages[0].Content.(string)
	if n := utf8.RuneCountInString(s); n > markdownChunkBudget {
		t.Fatalf("first markdown message must be <= %d runes, got %d", markdownChunkBudget, n)
	}
}
