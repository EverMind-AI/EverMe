package conversation

import (
	"os"
	"strings"
	"testing"
)

func TestClaudeCodeParseCounts(t *testing.T) {
	sc := NewClaudeCodeScanner()
	conv, err := sc.Read(Item{Platform: PlatformClaudeCode, Path: "testdata/claude_code_sample.jsonl"})
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
	// fixture has 2 tool_use blocks and 2 tool_result blocks
	if toolCalls == 0 || toolResults == 0 {
		t.Fatalf("expected tool trajectory, got calls=%d results=%d", toolCalls, toolResults)
	}
	if conv.ID == "" {
		t.Fatal("conversationId must be set")
	}
	// expected: 2 tool calls, 2 tool results
	if toolCalls != 2 {
		t.Fatalf("expected 2 toolCalls, got %d", toolCalls)
	}
	if toolResults != 2 {
		t.Fatalf("expected 2 toolResults, got %d", toolResults)
	}
	// fixture: 1 user + 1 assistant(tool_use) + 1 tool + 1 assistant(tool_use) + 1 tool + 1 user + 1 assistant = 7
	if len(conv.Messages) != 7 {
		t.Fatalf("expected 7 total messages, got %d", len(conv.Messages))
	}
}

func TestClaudeCodeToolArgRedaction(t *testing.T) {
	// Build a single-line JSONL fixture with a secret in the tool_use input.
	line := `{"type":"say","timestamp":1749000001000,"sessionId":"sess-redact-001","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_redact","name":"Bash","input":{"cmd":"curl -H 'Authorization: Bearer sk-redactme0123456789ABCDEF' https://api.example.com"}}]}}`
	dir := t.TempDir()
	path := dir + "/redact_test.jsonl"
	if err := os.WriteFile(path, []byte(line+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	sc := NewClaudeCodeScanner()
	conv, err := sc.Read(Item{Platform: PlatformClaudeCode, Path: path})
	if err != nil {
		t.Fatal(err)
	}
	if len(conv.Messages) == 0 {
		t.Fatal("expected at least one message")
	}
	var found bool
	for _, m := range conv.Messages {
		for _, tc := range m.ToolCalls {
			found = true
			if strings.Contains(tc.Arguments, "sk-redactme") {
				t.Fatalf("raw secret not redacted in Arguments: %q", tc.Arguments)
			}
			if !strings.Contains(tc.Arguments, "[redacted]") {
				t.Fatalf("expected [redacted] in Arguments, got: %q", tc.Arguments)
			}
		}
	}
	if !found {
		t.Fatal("no tool calls found in parsed messages")
	}
}

func TestClaudeCodeScannerPlatform(t *testing.T) {
	sc := NewClaudeCodeScanner()
	if sc.Platform() != PlatformClaudeCode {
		t.Fatalf("expected %s, got %s", PlatformClaudeCode, sc.Platform())
	}
}

func TestClaudeCodeScanMissingDir(t *testing.T) {
	sc := NewClaudeCodeScanner()
	items, err := sc.Scan([]string{"/no/such/dir/ever"})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("missing dir should yield 0 items, got %d", len(items))
	}
}
