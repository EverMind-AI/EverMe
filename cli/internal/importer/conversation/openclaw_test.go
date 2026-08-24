package conversation

import (
	"os"
	"testing"
)

func TestOpenClawParseCounts(t *testing.T) {
	sc := NewOpenClawScanner()
	conv, err := sc.Read(Item{Platform: PlatformOpenClaw, Path: "testdata/openclaw_sample.trajectory.jsonl"})
	if err != nil {
		t.Fatal(err)
	}
	var toolCalls, toolResults int
	for _, m := range conv.Messages {
		toolCalls += len(m.ToolCalls)
		if m.Role == "tool" {
			toolResults++
		}
	}
	// fixture has 2 toolCall blocks and 2 toolResult messages in snapshot
	if toolCalls == 0 || toolResults == 0 {
		t.Fatalf("expected tool trajectory, got calls=%d results=%d", toolCalls, toolResults)
	}
	if conv.ID == "" {
		t.Fatal("conversationId must be set")
	}
	if toolCalls != 2 {
		t.Fatalf("expected 2 toolCalls, got %d", toolCalls)
	}
	if toolResults != 2 {
		t.Fatalf("expected 2 toolResults, got %d", toolResults)
	}
	// fixture snapshot: 1 user + 2 assistant(toolCall) + 2 toolResult + 1 assistant(text) = 6
	if len(conv.Messages) != 6 {
		t.Fatalf("expected 6 total messages, got %d", len(conv.Messages))
	}
}

// TestOpenClawNoModelCompleted verifies that a file with only session.started/session.ended
// (no model.completed event) returns a non-nil conv with a warning and no error.
func TestOpenClawNoModelCompleted(t *testing.T) {
	fixture := `{"type":"session.started","ts":"2026-06-01T10:00:00.000Z","sessionId":"sess-empty-001"}
{"type":"session.ended","ts":"2026-06-01T10:01:00.000Z","sessionId":"sess-empty-001"}
`
	dir := t.TempDir()
	path := dir + "/empty.trajectory.jsonl"
	if err := os.WriteFile(path, []byte(fixture), 0o644); err != nil {
		t.Fatal(err)
	}
	sc := NewOpenClawScanner()
	conv, err := sc.Read(Item{Platform: PlatformOpenClaw, Path: path})
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if conv == nil {
		t.Fatal("expected non-nil conv")
	}
	if len(conv.Messages) != 0 {
		t.Fatalf("expected 0 messages for snapshot-less file, got %d", len(conv.Messages))
	}
	if len(conv.Warnings) == 0 {
		t.Fatal("expected at least one warning about missing model.completed")
	}
}

func TestOpenClawScannerPlatform(t *testing.T) {
	sc := NewOpenClawScanner()
	if sc.Platform() != PlatformOpenClaw {
		t.Fatalf("expected %s, got %s", PlatformOpenClaw, sc.Platform())
	}
}

func TestOpenClawScanMissingDir(t *testing.T) {
	sc := NewOpenClawScanner()
	items, err := sc.Scan([]string{"/no/such/dir/openclaw"})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("missing dir should yield 0 items, got %d", len(items))
	}
}

func TestOpenClawSessionIDFromFile(t *testing.T) {
	sc := NewOpenClawScanner()
	conv, err := sc.Read(Item{Platform: PlatformOpenClaw, Path: "testdata/openclaw_sample.trajectory.jsonl"})
	if err != nil {
		t.Fatal(err)
	}
	// conv.ID should embed the session ID from the fixture (sess-oc-001)
	if conv.ID == "" {
		t.Fatal("conversationId must be set")
	}
}
