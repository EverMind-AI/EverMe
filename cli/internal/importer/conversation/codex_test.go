package conversation

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCodexParseCounts(t *testing.T) {
	sc := NewCodexScanner()
	conv, err := sc.Read(Item{Platform: PlatformCodex, Path: "testdata/codex_sample.jsonl"})
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
	// fixture has 2 function_call and 2 function_call_output
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
	// fixture: 2 user + 2 assistant(func_call) + 2 tool + 2 assistant(text) = 8
	if len(conv.Messages) != 8 {
		t.Fatalf("expected 8 total messages, got %d", len(conv.Messages))
	}
}

func TestCodexScannerPlatform(t *testing.T) {
	sc := NewCodexScanner()
	if sc.Platform() != PlatformCodex {
		t.Fatalf("expected %s, got %s", PlatformCodex, sc.Platform())
	}
}

func TestCodexScanIgnoresTrajectoryFiles(t *testing.T) {
	dir := t.TempDir()
	// An OpenClaw trajectory file lives under a dir Codex might also walk.
	traj := filepath.Join(dir, "sess.trajectory.jsonl")
	if err := os.WriteFile(traj, []byte(`{"type":"session.started"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A genuine codex session in the same dir must still be picked up.
	codex := filepath.Join(dir, "rollout.jsonl")
	if err := os.WriteFile(codex, []byte(`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"text","text":"hi"}]}}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	sc := NewCodexScanner()
	items, err := sc.Scan([]string{dir})
	if err != nil {
		t.Fatal(err)
	}
	for _, it := range items {
		if strings.HasSuffix(it.Path, ".trajectory.jsonl") {
			t.Fatalf("codex scanner must not claim OpenClaw trajectory file: %s", it.Path)
		}
	}
	if len(items) != 1 || !strings.HasSuffix(items[0].Path, "rollout.jsonl") {
		t.Fatalf("expected only the genuine codex session, got %d items: %+v", len(items), items)
	}
}

func TestCodexScanMissingDir(t *testing.T) {
	sc := NewCodexScanner()
	items, err := sc.Scan([]string{"/no/such/dir/codex"})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("missing dir should yield 0 items, got %d", len(items))
	}
}

// TestCodexKeepsNonFunctionToolFamilies is the regression for the
// 2026-08-17 review item 1.2.2. The reader recognised exactly four
// response_item payload types, so every tool family Codex has added
// since - custom_tool_call (the `exec` sandbox tool) and web_search_call
// - was counted as "unknown" and dropped. On a real 44-session home that
// silently lost 183 paired custom tool round-trips and 106 searches.
func TestCodexKeepsNonFunctionToolFamilies(t *testing.T) {
	lines := []string{
		`{"type":"response_item","timestamp":"2026-08-01T00:00:00Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"list the repo"}]}}`,
		`{"type":"response_item","timestamp":"2026-08-01T00:00:01Z","payload":{"type":"custom_tool_call","id":"ctc_1","call_id":"call_exec_1","name":"exec","input":"ls -la"}}`,
		`{"type":"response_item","timestamp":"2026-08-01T00:00:02Z","payload":{"type":"custom_tool_call_output","id":"ctco_1","call_id":"call_exec_1","output":[{"type":"input_text","text":"AGENTS.md"}]}}`,
		`{"type":"response_item","timestamp":"2026-08-01T00:00:03Z","payload":{"type":"web_search_call","status":"completed","action":{"type":"search","query":"codex rollout schema"}}}`,
	}
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	conv, err := NewCodexScanner().Read(Item{Platform: PlatformCodex, Path: path})
	if err != nil {
		t.Fatal(err)
	}

	var call *AgentMemoryToolCall
	var search *AgentMemoryToolCall
	var result *AgentMemoryMessage
	for i := range conv.Messages {
		m := &conv.Messages[i]
		if m.Role == "tool" && m.ToolCallID == "call_exec_1" {
			result = m
		}
		for j := range m.ToolCalls {
			switch m.ToolCalls[j].Name {
			case "exec":
				call = &m.ToolCalls[j]
			case "web_search":
				search = &m.ToolCalls[j]
			}
		}
	}

	if call == nil {
		t.Fatal("custom_tool_call must become an assistant tool call")
	}
	if call.ID != "call_exec_1" {
		t.Fatalf("custom tool call id: want call_exec_1, got %q", call.ID)
	}
	if !strings.Contains(call.Arguments, "ls -la") {
		t.Fatalf("custom tool call arguments must carry the input, got %q", call.Arguments)
	}
	if result == nil {
		t.Fatal("custom_tool_call_output must become a tool message paired by call_id")
	}
	if s, _ := result.Content.(string); !strings.Contains(s, "AGENTS.md") {
		t.Fatalf("custom tool result content: got %q", result.Content)
	}
	if search == nil {
		t.Fatal("web_search_call must become an assistant tool call")
	}
	if !strings.Contains(search.Arguments, "codex rollout schema") {
		t.Fatalf("web_search arguments must carry the query, got %q", search.Arguments)
	}
	for _, w := range conv.Warnings {
		if strings.Contains(w, "unknown") {
			t.Fatalf("no payload type in this fixture is unknown, got warning %q", w)
		}
	}
}

// TestCodexEventMsgSkipsKnownAndWarnsOnDrift: event_msg was dropped as a
// whole class without a word, so a new Codex event type could carry
// content we never noticed we were missing. Known types stay silent
// (mcp_tool_call_end and web_search_end duplicate the response_item
// records - 97.3% of mcp call ids on a real home also appear as
// function_call, so mapping them would double-write); anything else
// leaves a warning that scan --detail can surface.
func TestCodexEventMsgSkipsKnownAndWarnsOnDrift(t *testing.T) {
	lines := []string{
		`{"type":"response_item","timestamp":"2026-08-01T00:00:00Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}`,
		`{"type":"event_msg","timestamp":"2026-08-01T00:00:01Z","payload":{"type":"token_count","info":{}}}`,
		`{"type":"event_msg","timestamp":"2026-08-01T00:00:02Z","payload":{"type":"mcp_tool_call_end","call_id":"call_dup_1"}}`,
		`{"type":"event_msg","timestamp":"2026-08-01T00:00:03Z","payload":{"type":"web_search_end"}}`,
		`{"type":"event_msg","timestamp":"2026-08-01T00:00:04Z","payload":{"type":"brand_new_event"}}`,
	}
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	conv, err := NewCodexScanner().Read(Item{Platform: PlatformCodex, Path: path})
	if err != nil {
		t.Fatal(err)
	}
	if len(conv.Messages) != 1 {
		t.Fatalf("event_msg records must not become messages, got %d", len(conv.Messages))
	}
	joined := strings.Join(conv.Warnings, "\n")
	if !strings.Contains(joined, "brand_new_event") {
		t.Fatalf("an unrecognised event_msg type must warn, got %q", joined)
	}
	for _, known := range []string{"token_count", "mcp_tool_call_end", "web_search_end"} {
		if strings.Contains(joined, known) {
			t.Fatalf("%s is a known skip and must stay silent, got %q", known, joined)
		}
	}
}
