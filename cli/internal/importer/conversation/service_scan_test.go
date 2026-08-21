package conversation

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// backdate sets a file's mtime an hour into the past so the active-session
// filter (mtime < activeSessionWindow) does not exclude test fixtures that
// are written fresh during the test.
func backdate(t *testing.T, path string) {
	t.Helper()
	old := time.Now().Add(-1 * time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
}

func TestScanSkipsActiveSession(t *testing.T) {
	dir := t.TempDir()
	fixture := `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"text","text":"hi"}]}}`

	// Fresh file (mtime ~now) — should be treated as the active session.
	active := filepath.Join(dir, "active.jsonl")
	if err := os.WriteFile(active, []byte(fixture+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Old file (backdated) — should be included.
	old := filepath.Join(dir, "old.jsonl")
	if err := os.WriteFile(old, []byte(fixture+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	oldTime := time.Now().Add(-1 * time.Hour)
	if err := os.Chtimes(old, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}

	svc := NewService(ServiceDeps{
		Roots:    map[PlatformID][]string{PlatformCodex: {dir}},
		Registry: DefaultRegistry(),
	})
	rep, err := svc.Scan([]PlatformID{PlatformCodex})
	if err != nil {
		t.Fatal(err)
	}

	for _, it := range rep.Items {
		if it.Path == active {
			t.Fatalf("active (fresh-mtime) session must be excluded from Items: %s", active)
		}
	}
	foundOld := false
	for _, it := range rep.Items {
		if it.Path == old {
			foundOld = true
		}
	}
	if !foundOld {
		t.Fatal("old session must be included in Items")
	}
	foundActive := false
	for _, p := range rep.SkippedActive {
		if p == active {
			foundActive = true
		}
	}
	if !foundActive {
		t.Fatalf("active session path must appear in SkippedActive, got %v", rep.SkippedActive)
	}
}

func TestScanMissingDirIsNotFatalAndAnnounced(t *testing.T) {
	svc := NewService(ServiceDeps{Roots: map[PlatformID][]string{PlatformCodex: {"/no/such/dir"}}, Registry: DefaultRegistry()})
	rep, err := svc.Scan([]PlatformID{PlatformCodex})
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Items) != 0 {
		t.Fatal("missing dir -> 0 items")
	}
	if rep.NotFound[PlatformCodex] == "" {
		t.Fatal("missing dir must produce an explicit not-found notice")
	}
}

func TestScanDirExistsButEmpty(t *testing.T) {
	dir := t.TempDir()
	svc := NewService(ServiceDeps{
		Roots:    map[PlatformID][]string{PlatformCodex: {dir}},
		Registry: DefaultRegistry(),
	})
	rep, err := svc.Scan([]PlatformID{PlatformCodex})
	if err != nil {
		t.Fatal(err)
	}
	// dir exists but 0 parseable files -> drift warning
	if len(rep.DriftWarnings) == 0 {
		t.Fatal("empty dir must produce a drift warning")
	}
}

func TestScanReturnsItemsWithPathAndDate(t *testing.T) {
	dir := t.TempDir()
	// write a valid codex JSONL fixture
	fixture := `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"text","text":"hello"}],"created_at":1748736000}}`
	f := filepath.Join(dir, "sess_abc.jsonl")
	if err := os.WriteFile(f, []byte(fixture+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	backdate(t, f)
	svc := NewService(ServiceDeps{
		Roots:    map[PlatformID][]string{PlatformCodex: {dir}},
		Registry: DefaultRegistry(),
	})
	rep, err := svc.Scan([]PlatformID{PlatformCodex})
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Items) == 0 {
		t.Fatal("expected at least 1 item")
	}
	item := rep.Items[0]
	if item.Path == "" {
		t.Fatal("item must have path")
	}
	if item.UpdatedAt == "" {
		t.Fatal("item must have UpdatedAt date")
	}
	if item.MessageCount <= 0 {
		t.Fatalf("expected MessageCount > 0, got %d", item.MessageCount)
	}
}

// FIX 4 — a file the scanner parses to 0 messages must be marked unsupported
// and excluded from Items (the server rejects empty messages).
func TestScanExcludesZeroMessageItems(t *testing.T) {
	dir := t.TempDir()
	// Valid JSONL the codex scanner reads without error but yields 0 messages
	// (no message payloads at all).
	fixture := `{"type":"response_item","payload":{"type":"reasoning","summary":[]}}`
	f := filepath.Join(dir, "empty.jsonl")
	if err := os.WriteFile(f, []byte(fixture+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	backdate(t, f)
	svc := NewService(ServiceDeps{
		Roots:    map[PlatformID][]string{PlatformCodex: {dir}},
		Registry: DefaultRegistry(),
	})
	rep, err := svc.Scan([]PlatformID{PlatformCodex})
	if err != nil {
		t.Fatal(err)
	}
	for _, it := range rep.Items {
		if it.Path == f {
			t.Fatalf("0-message item must be excluded from Items, got %+v", it)
		}
	}
}

func TestScanPopulatesStartedAtFromEarliestMessage(t *testing.T) {
	dir := t.TempDir()
	// Two messages: the earlier one (2026-05-01) must drive StartedAt even
	// though it appears second in the file.
	lines := `{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"later"}]},"timestamp":"2026-05-02T10:00:00Z"}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"earlier"}]},"timestamp":"2026-05-01T08:00:00Z"}
`
	f := filepath.Join(dir, "sess_started.jsonl")
	if err := os.WriteFile(f, []byte(lines), 0o644); err != nil {
		t.Fatal(err)
	}
	backdate(t, f)
	svc := NewService(ServiceDeps{
		Roots:    map[PlatformID][]string{PlatformCodex: {dir}},
		Registry: DefaultRegistry(),
	})
	rep, err := svc.Scan([]PlatformID{PlatformCodex})
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Items) == 0 {
		t.Fatal("expected an item")
	}
	got := rep.Items[0].StartedAt
	if got == "" {
		t.Fatal("StartedAt must be populated from earliest message timestamp")
	}
	if got[:10] != "2026-05-01" {
		t.Fatalf("StartedAt should reflect earliest message (2026-05-01), got %q", got)
	}
}
