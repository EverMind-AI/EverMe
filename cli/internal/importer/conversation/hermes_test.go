package conversation

import "testing"

func TestHermesParseCounts(t *testing.T) {
	sc := NewHermesScanner()
	conv, err := sc.Read(Item{Platform: PlatformHermes, Path: "testdata/hermes_sample.json"})
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
	// fixture has 2 assistant messages with tool_calls and 2 tool messages
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
	// fixture: 2 user + 2 assistant(tool_calls) + 2 tool + 1 assistant(text) = 7
	if len(conv.Messages) != 7 {
		t.Fatalf("expected 7 total messages, got %d", len(conv.Messages))
	}
}

func TestHermesScannerPlatform(t *testing.T) {
	sc := NewHermesScanner()
	if sc.Platform() != PlatformHermes {
		t.Fatalf("expected %s, got %s", PlatformHermes, sc.Platform())
	}
}

func TestHermesScanMissingDir(t *testing.T) {
	sc := NewHermesScanner()
	items, err := sc.Scan([]string{"/no/such/dir/hermes"})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("missing dir should yield 0 items, got %d", len(items))
	}
}

func TestHermesSessionIDInConvID(t *testing.T) {
	sc := NewHermesScanner()
	conv, err := sc.Read(Item{Platform: PlatformHermes, Path: "testdata/hermes_sample.json"})
	if err != nil {
		t.Fatal(err)
	}
	// session_id from fixture is "hermes-sess-001"
	if conv.Item.OriginID != "hermes-sess-001" {
		t.Fatalf("expected OriginID=hermes-sess-001, got %q", conv.Item.OriginID)
	}
}
