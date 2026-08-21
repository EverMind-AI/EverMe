package conversation

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkBuddyParseCounts(t *testing.T) {
	sc := NewWorkBuddyScanner()
	conv, err := sc.Read(Item{Platform: PlatformWorkBuddy, Path: "testdata/workbuddy_sample.jsonl"})
	if err != nil {
		t.Fatal(err)
	}

	var toolCalls, toolResults int
	var userTexts []string
	for _, m := range conv.Messages {
		toolCalls += len(m.ToolCalls)
		if m.Role == "tool" {
			toolResults++
		}
		if m.Role == "user" {
			if s, ok := m.Content.(string); ok {
				userTexts = append(userTexts, s)
			}
		}
	}

	// fixture: reasoning/file-history-snapshot/ai-title skipped, the
	// internal compact message dropped. Remaining: 4 cleaned user turns
	// (first-message system-reminder, additional_data-only, cb_summary,
	// ordinary-later-turn system-reminder), 1 plain assistant turn, 1
	// function_call, 1 function_call_result = 8.
	if len(conv.Messages) != 8 {
		t.Fatalf("expected 8 messages, got %d: %+v", len(conv.Messages), conv.Messages)
	}
	if toolCalls != 1 {
		t.Fatalf("expected 1 toolCall, got %d", toolCalls)
	}
	if toolResults != 1 {
		t.Fatalf("expected 1 tool result message, got %d", toolResults)
	}
	if conv.ID == "" {
		t.Fatal("conversationId must be set")
	}

	for _, text := range userTexts {
		if strings.Contains(text, "system-reminder") || strings.Contains(text, "identity_context") {
			t.Fatalf("system-reminder wrapper leaked into a user message: %q", text)
		}
		if strings.Contains(text, "additional_data") || strings.Contains(text, "memory_and_skills_reminder") {
			t.Fatalf("boilerplate tag leaked into a user message: %q", text)
		}
		if strings.Contains(text, "cb_summary") || strings.Contains(text, "previous_assistant_message") {
			t.Fatalf("cb_summary wrapper leaked into a user message: %q", text)
		}
	}

	// The real point of this fixture: the actual question a user typed must
	// survive extraction regardless of which wrapper buried it - the first
	// message's whole-session context dump, a bare additional_data tag, a
	// compaction summary, or an ordinary later turn's own reminder
	// injection. A real WorkBuddy upload against this machine's own history
	// showed every one of these wrappers in practice; dropping any of them
	// whole (the original, wrong assumption) silently loses the user's real
	// question every time.
	want := []string{
		"what's for dinner tonight?",
		"what is the weather today?",
		"continue the compaction test please",
		"what did I do yesterday?",
	}
	for _, w := range want {
		found := false
		for _, text := range userTexts {
			if text == w {
				found = true
			}
		}
		if !found {
			t.Fatalf("expected %q among cleaned user messages, got %v", w, userTexts)
		}
	}
}

func TestWorkBuddyScannerPlatform(t *testing.T) {
	sc := NewWorkBuddyScanner()
	if sc.Platform() != PlatformWorkBuddy {
		t.Fatalf("expected %s, got %s", PlatformWorkBuddy, sc.Platform())
	}
}

func TestWorkBuddyScanMissingDir(t *testing.T) {
	sc := NewWorkBuddyScanner()
	items, err := sc.Scan([]string{"/no/such/dir/workbuddy"})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("missing dir should yield 0 items, got %d", len(items))
	}
}

func TestWorkBuddyScanFindsSessionFiles(t *testing.T) {
	dir := t.TempDir()
	projectDir := filepath.Join(dir, "Users-admin-WorkBuddy-2026-08-14-10-30-18")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}
	sess := filepath.Join(projectDir, "0a8db3b2-7a10-4e75-ab43-92cebbe73857.jsonl")
	line := `{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}],"sessionId":"0a8db3b2-7a10-4e75-ab43-92cebbe73857"}` + "\n"
	if err := os.WriteFile(sess, []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}
	// The reserved-but-unused <uuid>/tool-results/ sibling dir must not
	// confuse the walk (it shares no extension with anything we'd claim).
	toolResults := filepath.Join(projectDir, "0a8db3b2-7a10-4e75-ab43-92cebbe73857", "tool-results")
	if err := os.MkdirAll(toolResults, 0o755); err != nil {
		t.Fatal(err)
	}

	sc := NewWorkBuddyScanner()
	items, err := sc.Scan([]string{dir})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Path != sess {
		t.Fatalf("expected exactly the one session file, got %+v", items)
	}
}
