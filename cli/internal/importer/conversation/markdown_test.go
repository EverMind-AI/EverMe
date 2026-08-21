package conversation

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mustWriteMD(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestMarkdownScanCuratedZonesOnly pins the cold-start markdown scope to the
// curated zones (depth-1 persona files + the agent's memory/projects subtree)
// instead of recursively sweeping the whole agent home dir. Agent home dirs
// are full of installed-software docs (plugin SKILL.md, dependency README.md,
// caches) that must never be uploaded to memory.
func TestMarkdownScanCuratedZonesOnly(t *testing.T) {
	claudeHome := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", claudeHome)

	// Curated content — MUST be picked up.
	mustWriteMD(t, filepath.Join(claudeHome, "CLAUDE.md"), "persona memory")
	mustWriteMD(t, filepath.Join(claudeHome, "projects", "proj1", "notes.md"), "project notes")

	// Tooling / dependency docs — MUST NOT be picked up.
	mustWriteMD(t, filepath.Join(claudeHome, "plugins", "mkt", "SKILL.md"), "plugin skill doc")
	mustWriteMD(t, filepath.Join(claudeHome, "cache", "x", "README.md"), "third-party readme")
	mustWriteMD(t, filepath.Join(claudeHome, "projects", "proj1", "node_modules", "pkg", "README.md"), "dep readme")

	sc := NewMarkdownScanner()
	items, err := sc.Scan([]string{claudeHome})
	if err != nil {
		t.Fatal(err)
	}

	got := map[string]bool{}
	for _, it := range items {
		got[it.Path] = true
	}
	for _, w := range []string{
		filepath.Join(claudeHome, "CLAUDE.md"),
		filepath.Join(claudeHome, "projects", "proj1", "notes.md"),
	} {
		if !got[w] {
			t.Errorf("expected curated file in scan, missing: %s", w)
		}
	}
	for _, w := range []string{
		filepath.Join(claudeHome, "plugins", "mkt", "SKILL.md"),
		filepath.Join(claudeHome, "cache", "x", "README.md"),
		filepath.Join(claudeHome, "projects", "proj1", "node_modules", "pkg", "README.md"),
	} {
		if got[w] {
			t.Errorf("tooling/dependency doc must NOT be scanned: %s", w)
		}
	}
	if len(items) != 2 {
		t.Errorf("expected exactly 2 curated items, got %d", len(items))
	}
}

func TestMarkdownToSingleUserMessage(t *testing.T) {
	sc := NewMarkdownScanner()
	conv, err := sc.Read(Item{Platform: PlatformMarkdown, Path: "testdata/sample.md"})
	if err != nil {
		t.Fatal(err)
	}
	if len(conv.Messages) != 1 || conv.Messages[0].Role != "user" {
		t.Fatalf("md must become one user message, got %+v", conv.Messages)
	}
	if conv.ID == "" {
		t.Fatal("conversationId must be set")
	}
}

func TestMarkdownTimestampFromMtime(t *testing.T) {
	sc := NewMarkdownScanner()
	conv, err := sc.Read(Item{Platform: PlatformMarkdown, Path: "testdata/sample.md"})
	if err != nil {
		t.Fatal(err)
	}
	if conv.Messages[0].Timestamp == 0 {
		t.Fatal("timestamp must be set from file mtime")
	}
}

// joinContents concatenates the string Content of every message, in order.
func joinContents(t *testing.T, conv *Conversation) string {
	t.Helper()
	var b strings.Builder
	for i, m := range conv.Messages {
		s, ok := m.Content.(string)
		if !ok {
			t.Fatalf("message %d content not a string: %T", i, m.Content)
		}
		b.WriteString(s)
	}
	return b.String()
}

// TestMarkdownSplitsOversizeIntoMessages: a file over the per-message cap is
// split into multiple user messages in the SAME Messages array, each within
// the cap, with NO content loss.
func TestMarkdownSplitsOversizeIntoMessages(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/big.md"
	content := strings.Repeat("a", 9000) // no newlines -> hard split at budget
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	sc := NewMarkdownScanner()
	conv, err := sc.Read(Item{Platform: PlatformMarkdown, Path: path})
	if err != nil {
		t.Fatal(err)
	}
	if len(conv.Messages) != 2 {
		t.Fatalf("9000 runes should split into 2 messages, got %d", len(conv.Messages))
	}
	for i, m := range conv.Messages {
		if m.Role != "user" {
			t.Errorf("message %d role = %q, want user", i, m.Role)
		}
		s := m.Content.(string)
		if n := len([]rune(s)); n > markdownChunkBudget {
			t.Errorf("message %d has %d runes, exceeds cap %d", i, n, markdownChunkBudget)
		}
	}
	if got := joinContents(t, conv); got != content {
		t.Fatalf("content lost in split: joined len %d, want %d", len([]rune(got)), len([]rune(content)))
	}
	if conv.Messages[1].Timestamp <= conv.Messages[0].Timestamp {
		t.Errorf("split message timestamps must be strictly increasing: %d then %d",
			conv.Messages[0].Timestamp, conv.Messages[1].Timestamp)
	}
}

// TestMarkdownSplitPrefersNewlineBoundary: the cut point favors the last
// newline in the back of a chunk so sections stay whole.
func TestMarkdownSplitPrefersNewlineBoundary(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/lines.md"
	// Newline at rune index 7900 (within the back 20% of an 8000 budget).
	content := strings.Repeat("a", 7900) + "\n" + strings.Repeat("b", 2000)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	sc := NewMarkdownScanner()
	conv, err := sc.Read(Item{Platform: PlatformMarkdown, Path: path})
	if err != nil {
		t.Fatal(err)
	}
	if len(conv.Messages) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(conv.Messages))
	}
	first := conv.Messages[0].Content.(string)
	if !strings.HasSuffix(first, "\n") {
		t.Errorf("first chunk should end at the newline boundary, got tail %q", first[len(first)-5:])
	}
	if strings.Contains(first, "b") {
		t.Errorf("first chunk leaked content from past the newline boundary")
	}
}

// TestMarkdownLargeFileFullyPreservedAcrossMessages: there is no message-count
// cap. A file admitted by the scan-time size limit is uploaded in full, split
// into as many messages as it needs, with zero content loss and every message
// within the per-message budget.
func TestMarkdownLargeFileFullyPreservedAcrossMessages(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/huge.md"
	// Far more than any fixed chunk-count cap would have allowed.
	const n = 100*markdownChunkBudget + 123
	content := strings.Repeat("a", n)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	sc := NewMarkdownScanner()
	conv, err := sc.Read(Item{Platform: PlatformMarkdown, Path: path})
	if err != nil {
		t.Fatal(err)
	}
	wantChunks := (n + markdownChunkBudget - 1) / markdownChunkBudget // ceil
	if len(conv.Messages) != wantChunks {
		t.Fatalf("expected %d messages (no count cap), got %d", wantChunks, len(conv.Messages))
	}
	for i, m := range conv.Messages {
		if c := len([]rune(m.Content.(string))); c > markdownChunkBudget {
			t.Errorf("message %d has %d runes, exceeds budget %d", i, c, markdownChunkBudget)
		}
	}
	if got := joinContents(t, conv); got != content {
		t.Fatalf("content lost: joined %d runes, want %d", len([]rune(got)), n)
	}
}

// TestMarkdownOver64KBSplitsIntoMultipleBoundedPosts proves the end-to-end
// composition for a file far larger than the per-POST object limit: Read splits
// it into <=budget-rune messages, and the uploader's byte batcher then groups
// those into multiple POSTs each within maxAgentBatchBytes (64 KiB) — same
// conversationId, order preserved, zero content loss.
func TestMarkdownOver64KBSplitsIntoMultipleBoundedPosts(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/over64k.md"
	const runes = 200_000 // ~200 KB ASCII, ~3x the 64 KiB POST budget
	content := strings.Repeat("a", runes)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	conv, err := NewMarkdownScanner().Read(Item{Platform: PlatformMarkdown, Path: path})
	if err != nil {
		t.Fatal(err)
	}

	// Layer 1: every message is within the server's per-message rune cap.
	for i, m := range conv.Messages {
		if n := len([]rune(m.Content.(string))); n > markdownChunkBudget {
			t.Fatalf("message %d: %d runes exceeds per-message cap %d", i, n, markdownChunkBudget)
		}
	}

	// Layer 2: the uploader batches those messages into multiple POSTs, each
	// within the 64 KiB object limit, with no single message stranded oversize.
	batches := batchMessagesByBytes(conv.Messages, maxAgentBatchBytes)
	if len(batches) < 2 {
		t.Fatalf("a >64 KiB file must span multiple POSTs, got %d batch(es)", len(batches))
	}
	var seen int
	for bi, batch := range batches {
		total := 0
		for _, m := range batch {
			total += messageBytes(m)
			seen++
		}
		if total > maxAgentBatchBytes {
			t.Errorf("batch %d is %d bytes, exceeds object limit %d", bi, total, maxAgentBatchBytes)
		}
	}
	if seen != len(conv.Messages) {
		t.Fatalf("batching lost messages: %d batched vs %d total", seen, len(conv.Messages))
	}

	// Zero content loss across the whole split-and-batch pipeline.
	if got := joinContents(t, conv); got != content {
		t.Fatalf("content lost: joined %d runes, want %d", len([]rune(got)), runes)
	}
}

// TestMarkdownSecretStraddlingChunkBoundaryRedacted: redaction runs on the
// full text BEFORE splitting, so a credential straddling a chunk boundary is
// still removed (redact-after-split would leak the two halves).
func TestMarkdownSecretStraddlingChunkBoundaryRedacted(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/straddle.md"
	secret := "evt_" + strings.Repeat("b", 20) // matches evt_[A-Za-z0-9_-]{8,}
	// Place the secret so it spans the first budget boundary (rune 8000).
	content := strings.Repeat("a", markdownChunkBudget-5) + secret + strings.Repeat("c", 1000)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	sc := NewMarkdownScanner()
	conv, err := sc.Read(Item{Platform: PlatformMarkdown, Path: path})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(joinContents(t, conv), secret) {
		t.Fatalf("secret straddling chunk boundary was not redacted")
	}
}

func TestMarkdownRedact(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/secret.md"
	content := "My token is evt_0123456789abcdef and my key sk-ABCDEF0123456789ABCDEF"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	sc := NewMarkdownScanner()
	conv, err := sc.Read(Item{Platform: PlatformMarkdown, Path: path})
	if err != nil {
		t.Fatal(err)
	}
	text, ok := conv.Messages[0].Content.(string)
	if !ok {
		t.Fatal("content must be string")
	}
	if strings.Contains(text, "evt_0123456789abcdef") || strings.Contains(text, "sk-ABCDEF") {
		t.Fatalf("secrets not redacted in: %q", text)
	}
}

func TestMarkdownScanMissingDir(t *testing.T) {
	sc := NewMarkdownScanner()
	items, err := sc.Scan([]string{"/no/such/dir/markdown"})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("missing dir should yield 0 items, got %d", len(items))
	}
}
