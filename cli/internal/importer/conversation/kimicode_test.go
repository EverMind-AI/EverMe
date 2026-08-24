package conversation

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestKimicodeScannerPlatform(t *testing.T) {
	if NewKimicodeScanner().Platform() != PlatformKimicode {
		t.Fatalf("expected %s", PlatformKimicode)
	}
}

func TestKimicodeScanMissingDir(t *testing.T) {
	items, err := NewKimicodeScanner().Scan([]string{"/no/such/dir/kc"})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("missing dir should yield 0 items, got %d", len(items))
	}
}

func TestKimicodeScanDiscoversMainAndSubagents(t *testing.T) {
	dir := t.TempDir()
	sess := filepath.Join(dir, "sessions", "wd_proj_abc123", "session_uuid-1")
	mustWrite(t, filepath.Join(sess, "agents", "main", "wire.jsonl"), `{"type":"metadata"}`+"\n")
	mustWrite(t, filepath.Join(sess, "agents", "sub-9", "wire.jsonl"), `{"type":"metadata"}`+"\n")

	items, err := NewKimicodeScanner().Scan([]string{filepath.Join(dir, "sessions")})
	if err != nil {
		t.Fatal(err)
	}
	// Both the main agent and the subagent transcript are discovered.
	if len(items) != 2 {
		t.Fatalf("expected 2 items (main + subagent), got %d: %+v", len(items), items)
	}
	origins := map[string]bool{}
	for _, it := range items {
		origins[it.OriginID] = true
		if !strings.HasSuffix(it.Path, filepath.Join("wire.jsonl")) {
			t.Fatalf("unexpected path %s", it.Path)
		}
	}
	// Distinct origin ids so ConversationIDs don't collide.
	if !origins["session_uuid-1"] {
		t.Fatalf("missing main origin session_uuid-1; got %v", origins)
	}
	if !origins["session_uuid-1__sub-9"] {
		t.Fatalf("missing subagent origin session_uuid-1__sub-9; got %v", origins)
	}
}

func TestKimicodeParseCounts(t *testing.T) {
	conv, err := NewKimicodeScanner().Read(Item{
		Platform: PlatformKimicode,
		Path:     "testdata/kimicode_sample.jsonl",
		OriginID: "session_uuid-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	var users, assistantText, toolCalls, toolResults int
	for _, m := range conv.Messages {
		switch m.Role {
		case "user":
			users++
		case "assistant":
			if len(m.ToolCalls) > 0 {
				toolCalls += len(m.ToolCalls)
			} else if m.Content != nil {
				assistantText++
			}
		case "tool":
			toolResults++
		}
	}
	// 3 real user messages ("list the files", "thanks", "fetch the homepage");
	// injection + skill_activation pseudo-user messages filtered out.
	if users != 3 {
		t.Fatalf("expected 3 user messages, got %d", users)
	}
	// 2 aggregated assistant texts ("Here are the files:", "Let me fetch it."),
	// with "think" parts dropped.
	if assistantText != 2 {
		t.Fatalf("expected 2 assistant text messages, got %d", assistantText)
	}
	if toolCalls != 1 || toolResults != 1 {
		t.Fatalf("expected 1 tool call + 1 tool result, got calls=%d results=%d", toolCalls, toolResults)
	}
	if got := firstAssistantText(conv); got != "Here are the files:" {
		t.Fatalf("assistant text = %q (think part must be dropped)", got)
	}
	if conv.ID != "import-kimicode-session_uuid-1" {
		t.Fatalf("conversationId = %q", conv.ID)
	}
}

func TestKimicodeToolCallOrderAndShape(t *testing.T) {
	conv, err := NewKimicodeScanner().Read(Item{
		Platform: PlatformKimicode,
		Path:     "testdata/kimicode_sample.jsonl",
		OriginID: "s",
	})
	if err != nil {
		t.Fatal(err)
	}
	// Find the FetchURL tool call and assert its shape + that its preamble text
	// ("Let me fetch it.") precedes it and the tool result follows it.
	callIdx, resultIdx, preambleIdx := -1, -1, -1
	for i, m := range conv.Messages {
		if m.Role == "assistant" {
			if s, ok := m.Content.(string); ok && s == "Let me fetch it." {
				preambleIdx = i
			}
			for _, tc := range m.ToolCalls {
				if tc.Name == "FetchURL" {
					callIdx = i
					if tc.Arguments == "" || tc.ID != "call_abc" || tc.Type != "function" {
						t.Fatalf("bad tool call shape: %+v", tc)
					}
				}
			}
		}
		if m.Role == "tool" && m.ToolCallID == "call_abc" {
			resultIdx = i
			if s, _ := m.Content.(string); s != "the page body" {
				t.Fatalf("tool result content = %v", m.Content)
			}
		}
	}
	if preambleIdx < 0 || callIdx < 0 || resultIdx < 0 {
		t.Fatalf("missing message: preamble=%d call=%d result=%d", preambleIdx, callIdx, resultIdx)
	}
	if !(preambleIdx < callIdx && callIdx < resultIdx) {
		t.Fatalf("expected order preamble<call<result, got %d<%d<%d", preambleIdx, callIdx, resultIdx)
	}
}

func TestKimicodeRegistered(t *testing.T) {
	if DefaultRegistry().ScannerFor(PlatformKimicode) == nil {
		t.Fatal("kimicode scanner must be registered in DefaultRegistry")
	}
}

func firstAssistantText(conv *Conversation) string {
	for _, m := range conv.Messages {
		if m.Role == "assistant" {
			if s, ok := m.Content.(string); ok {
				return s
			}
		}
	}
	return ""
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
