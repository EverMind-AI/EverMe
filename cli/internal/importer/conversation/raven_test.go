package conversation

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRavenScannerPlatform(t *testing.T) {
	if NewRavenScanner().Platform() != PlatformRaven {
		t.Fatalf("expected %s", PlatformRaven)
	}
}

func TestRavenScanMissingDir(t *testing.T) {
	items, err := NewRavenScanner().Scan([]string{"/no/such/dir/raven"})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("missing dir should yield 0 items, got %d", len(items))
	}
}

func TestRavenScanDiscoversChannelSessions(t *testing.T) {
	dir := t.TempDir()
	sessions := filepath.Join(dir, "workspace", "sessions")
	mustWrite(t, filepath.Join(sessions, "cli", "20260703_101500_ab12cd.jsonl"), "{}\n")
	mustWrite(t, filepath.Join(sessions, "telegram", "20260702_090000_ff00aa.jsonl"), "{}\n")
	mustWrite(t, filepath.Join(sessions, "cli", "notes.txt"), "ignored\n")

	items, err := NewRavenScanner().Scan([]string{sessions})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 items, got %d: %+v", len(items), items)
	}
	origins := map[string]bool{}
	for _, it := range items {
		origins[it.OriginID] = true
	}
	// OriginID is Raven's own session key "<channel>:<chat_id>" so
	// re-imports stay idempotent across workspace moves.
	if !origins["cli:20260703_101500_ab12cd"] {
		t.Fatalf("missing cli origin; got %v", origins)
	}
	if !origins["telegram:20260702_090000_ff00aa"] {
		t.Fatalf("missing telegram origin; got %v", origins)
	}
}

func TestRavenParseSample(t *testing.T) {
	conv, err := NewRavenScanner().Read(Item{
		Platform: PlatformRaven,
		Path:     "testdata/raven_sample.jsonl",
		OriginID: "cli:20260703_101500_ab12cd",
	})
	if err != nil {
		t.Fatal(err)
	}

	var users, assistants, toolCalls, toolResults int
	for _, m := range conv.Messages {
		switch m.Role {
		case "user":
			users++
		case "assistant":
			assistants++
			toolCalls += len(m.ToolCalls)
		case "tool":
			toolResults++
		}
	}
	// 2 user messages (plain string + multimodal text parts joined,
	// image part dropped); the system message is dropped.
	if users != 2 {
		t.Fatalf("expected 2 user messages, got %d", users)
	}
	// 3 assistant messages: text+tool_call combined, plain text, parts text.
	if assistants != 3 {
		t.Fatalf("expected 3 assistant messages, got %d", assistants)
	}
	if toolCalls != 1 {
		t.Fatalf("expected 1 tool call, got %d", toolCalls)
	}
	// 1 valid tool result; the orphan without tool_call_id is skipped.
	if toolResults != 1 {
		t.Fatalf("expected 1 tool result, got %d", toolResults)
	}

	// Warnings: orphan tool result + non-JSON trailing line.
	if len(conv.Warnings) != 2 {
		t.Fatalf("expected 2 warnings, got %d: %v", len(conv.Warnings), conv.Warnings)
	}

	// Metadata records (appended twice by Raven's save) never become messages.
	for _, m := range conv.Messages {
		if s, ok := m.Content.(string); ok && strings.Contains(s, "_type") {
			t.Fatalf("metadata leaked into messages: %q", s)
		}
	}

	// tool_calls: function wrapper unwrapped, arguments stay a JSON string.
	var sawCall bool
	for _, m := range conv.Messages {
		for _, tc := range m.ToolCalls {
			sawCall = true
			if tc.ID != "call_001" || tc.Name != "run_shell" {
				t.Fatalf("unexpected tool call %+v", tc)
			}
			if !strings.Contains(tc.Arguments, `"cmd"`) {
				t.Fatalf("arguments not preserved: %q", tc.Arguments)
			}
		}
	}
	if !sawCall {
		t.Fatal("tool call not parsed")
	}

	// The combined assistant message keeps its preamble text alongside the call.
	if conv.Messages[1].Role != "assistant" || conv.Messages[1].Content != "Let me check." {
		t.Fatalf("expected combined text+tool_call assistant message, got %+v", conv.Messages[1])
	}

	// Multimodal user content joins text parts and drops non-text parts.
	last := conv.Messages[len(conv.Messages)-2]
	if last.Role != "user" || last.Content != "thanks,\nsummarize them" {
		t.Fatalf("multimodal user content mishandled: %+v", last)
	}

	if conv.ID == "" || conv.Item.StartedAt == "" {
		t.Fatalf("conversation id / startedAt not set: %+v", conv.Item)
	}
}

func TestRavenNaiveTimestampParsedInLocalZone(t *testing.T) {
	got := normalizeTimestampRaven("2026-07-03T10:15:01.500000", 42)
	want := time.Date(2026, 7, 3, 10, 15, 1, 500_000_000, time.Local).UnixMilli()
	if got != want {
		t.Fatalf("naive ISO parse: got %d want %d", got, want)
	}
	// Offset-carrying strings and epoch numbers defer to the shared helper.
	if normalizeTimestampRaven("2026-07-03T10:15:01Z", 42) != time.Date(2026, 7, 3, 10, 15, 1, 0, time.UTC).UnixMilli() {
		t.Fatal("RFC3339 fallback broken")
	}
	if normalizeTimestampRaven(float64(1751501762), 42) != 1751501762000 {
		t.Fatal("epoch-seconds fallback broken")
	}
	if normalizeTimestampRaven(nil, 42) != 42 {
		t.Fatal("fallback broken")
	}
}

func TestRavenSessionID(t *testing.T) {
	if got := ravenSessionID(filepath.Join("x", "sessions", "cli", "20260703_101500_ab12cd.jsonl")); got != "cli:20260703_101500_ab12cd" {
		t.Fatalf("got %q", got)
	}
}

func TestRavenResolveEvt(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("EVERCLI_RAVEN_CONFIG_DIR", dir)

	// Missing config file.
	if _, err := resolveRavenEvt(); err == nil {
		t.Fatal("expected error for missing config")
	}

	// Entry present with snake_case token.
	cfg := `{"memory":{"backend":"everme"},"plugins":{"config":{"everme-memory":{"agent_token":"evt_tok123","agent_id":"agt_1"}}}}`
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	tok, err := resolveRavenEvt()
	if err != nil {
		t.Fatal(err)
	}
	if tok != "evt_tok123" {
		t.Fatalf("got %q", tok)
	}

	// Empty token is an explicit error, not "".
	cfg = `{"plugins":{"config":{"everme-memory":{"agent_token":"  "}}}}`
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveRavenEvt(); err == nil {
		t.Fatal("expected error for empty token")
	}
}
