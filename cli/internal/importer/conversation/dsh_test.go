package conversation

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
)

// writeDSHSession writes one session log. compress selects the on-disk shape:
// DSH writes "session.v<version>.jsonl.zstd", older releases wrote plain JSONL.
func writeDSHSession(t *testing.T, path string, records []string, compress bool) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	body := []byte(strings.Join(records, "\n") + "\n")
	if !compress {
		if err := os.WriteFile(path, body, 0o600); err != nil {
			t.Fatal(err)
		}
		return
	}
	var buf bytes.Buffer
	zw, err := zstd.NewWriter(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := zw.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
}

func dshSampleSession() []string {
	return []string{
		`{"type":"session","version":4,"id":"session-1111","createdAt":1794487123540,"cwd":"/home/u/proj","isSeeded":false}`,
		`{"type":"turn/start","seq":1,"time":1794487124000,"data":{"turn":1}}`,
		`{"type":"step/start","seq":2,"time":1794487124100,"data":{"turn":1,"step":1}}`,
		`{"type":"user/message","seq":3,"time":1794487125000,"data":{"content":[{"type":"text","text":"why is the test red?"},{"type":"image","mediaType":"image/png"}],"role":"user","id":"m1"},"surfaceOp":"append"}`,
		`{"type":"system/message","seq":4,"time":1794487125100,"data":{"turn":1,"step":1,"message":{"role":"system","content":[{"type":"text","text":"you are dsh"}],"id":"m2"}}}`,
		`{"type":"assistant/message","seq":5,"time":1794487126000,"data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"text","text":"Let me look at the log."},{"type":"tool-call","id":"call_1","name":"pwsh","arguments":"{\"command\":\"npm test\"}"}],"id":"m3"}}}`,
		// Duplicate of the assistant message's tool-call block.
		`{"type":"tool/call","seq":6,"time":1794487126100,"data":{"turn":1,"step":1,"callId":"call_1","name":"pwsh","arguments":"{\"command\":\"npm test\"}"}}`,
		`{"type":"tool/result","seq":7,"time":1794487127000,"data":{"turn":1,"step":1,"message":{"role":"tool","toolCallId":"call_1","content":[{"type":"text","text":"1 failing"}],"isError":true,"id":"m4"}}}`,
		`{"type":"step/end","seq":8,"time":1794487127100,"data":{"turn":1,"step":1}}`,
		// Reasoning-only step: no user-visible text.
		`{"type":"assistant/message","seq":9,"time":1794487128000,"data":{"turn":1,"step":2,"message":{"role":"assistant","content":[{"type":"reasoning","text":"internal musing"}],"id":"m5"}}}`,
		`{"type":"session-log-deepseek/delivery-accepted","seq":10,"time":1794487129000,"data":{"sessionId":"session-1111","throughSeq":9}}`,
		// Context compaction is bookkeeping; its summary is not a user turn.
		`{"type":"compaction/summary","seq":12,"time":1794487131000,"data":{"summary":"earlier turns were compacted"}}`,
		`{"type":"future/thing","seq":11,"time":1794487130000,"data":{}}`,
	}
}

func TestDSHScannerParsesSession(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "sessions", "--proj--", "session-1111", "session.v4.jsonl.zstd")
	writeDSHSession(t, path, dshSampleSession(), true)
	t.Setenv("DSH_HOME", home)

	items, err := NewDSHScanner().Scan(DefaultRoots(PlatformDSH))
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("expected one session, got %d: %v", len(items), items)
	}
	if items[0].OriginID != "session-1111" {
		t.Fatalf("origin id must come from the session dir, got %q", items[0].OriginID)
	}

	conv, err := NewDSHScanner().Read(items[0])
	if err != nil {
		t.Fatal(err)
	}
	if conv.ID != "import-dsh-session-1111" {
		t.Fatalf("conversation id must be stable and derived from the header id, got %q", conv.ID)
	}
	if len(conv.Messages) != 3 {
		t.Fatalf("expected user + assistant + tool, got %d: %+v", len(conv.Messages), conv.Messages)
	}

	user, asst, tool := conv.Messages[0], conv.Messages[1], conv.Messages[2]
	if user.Role != "user" || !strings.Contains(user.Content.(string), "why is the test red?") {
		t.Fatalf("unexpected user message: %+v", user)
	}
	if asst.Role != "assistant" || !strings.Contains(asst.Content.(string), "Let me look at the log.") {
		t.Fatalf("unexpected assistant message: %+v", asst)
	}
	if len(asst.ToolCalls) != 1 {
		t.Fatalf("assistant message must carry its tool-call block, got %+v", asst.ToolCalls)
	}
	call := asst.ToolCalls[0]
	if call.ID != "call_1" || call.Name != "pwsh" || !strings.Contains(call.Arguments, "npm test") {
		t.Fatalf("unexpected tool call: %+v", call)
	}
	if tool.Role != "tool" || tool.ToolCallID != "call_1" {
		t.Fatalf("tool result must pair with the call id, got %+v", tool)
	}
	if !strings.HasPrefix(tool.Content.(string), "[error] ") {
		t.Fatalf("isError result must be marked, got %q", tool.Content)
	}

	for _, m := range conv.Messages {
		text, _ := m.Content.(string)
		if strings.Contains(text, "you are dsh") {
			t.Fatal("system/message is instructions, not conversation — it must be skipped")
		}
		if strings.Contains(text, "internal musing") {
			t.Fatal("reasoning blocks must be skipped")
		}
		if strings.Contains(text, "compacted") {
			t.Fatal("compaction summaries are bookkeeping, not conversation")
		}
	}

	if conv.Item.StartedAt == "" {
		t.Fatal("startedAt must be derived from the earliest message timestamp")
	}
	if !strings.HasPrefix(conv.Item.StartedAt, "2026-") {
		t.Fatalf("unexpected startedAt %q", conv.Item.StartedAt)
	}

	unknown := 0
	for _, w := range conv.Warnings {
		if strings.Contains(w, "future/thing") {
			unknown++
		}
		if strings.Contains(w, "you are dsh") || strings.Contains(w, "internal musing") {
			t.Fatalf("skipped-by-design content must not warn: %q", w)
		}
	}
	if unknown != 1 {
		t.Fatalf("expected exactly one warning about the unknown event type, got %v", conv.Warnings)
	}
}

func TestDSHScannerAcceptsUncompressedLog(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "sessions", "--proj--", "session-2222", "session.v3.jsonl")
	writeDSHSession(t, path, dshSampleSession(), false)
	t.Setenv("DSH_HOME", home)

	items, err := NewDSHScanner().Scan(DefaultRoots(PlatformDSH))
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("plain .jsonl sessions must be discovered too, got %d", len(items))
	}
	conv, err := NewDSHScanner().Read(items[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(conv.Messages) != 3 {
		t.Fatalf("expected the same three messages, got %d", len(conv.Messages))
	}
}

func TestDSHScannerImportsStandaloneToolCall(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "sessions", "--proj--", "session-3333", "session.v4.jsonl.zstd")
	writeDSHSession(t, path, []string{
		`{"type":"session","version":4,"id":"session-3333","createdAt":1794487123540}`,
		`{"type":"tool/call","seq":1,"time":1794487125000,"data":{"callId":"call_9","name":"read","arguments":"{\"path\":\"a.txt\"}"}}`,
		`{"type":"tool/result","seq":2,"time":1794487126000,"data":{"message":{"toolCallId":"call_9","content":[{"type":"text","text":"ok"}]}}}`,
	}, true)
	t.Setenv("DSH_HOME", home)

	items, err := NewDSHScanner().Scan(DefaultRoots(PlatformDSH))
	if err != nil {
		t.Fatal(err)
	}
	conv, err := NewDSHScanner().Read(items[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(conv.Messages) != 2 {
		t.Fatalf("a call with no assistant message must still be imported, got %+v", conv.Messages)
	}
	if conv.Messages[0].Role != "assistant" || len(conv.Messages[0].ToolCalls) != 1 {
		t.Fatalf("standalone call must become an assistant tool-call message, got %+v", conv.Messages[0])
	}
	if conv.Messages[1].Role != "tool" || conv.Messages[1].ToolCallID != "call_9" {
		t.Fatalf("tool result must pair with the standalone call, got %+v", conv.Messages[1])
	}
}

func TestDSHScannerWarnsOnNewerFormatVersion(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "sessions", "--proj--", "session-4444", "session.v9.jsonl.zstd")
	writeDSHSession(t, path, []string{
		`{"type":"session","version":9,"id":"session-4444","createdAt":1794487123540}`,
		`{"type":"user/message","seq":1,"time":1794487125000,"data":{"content":[{"type":"text","text":"hello"}],"role":"user"}}`,
	}, true)
	t.Setenv("DSH_HOME", home)

	items, err := NewDSHScanner().Scan(DefaultRoots(PlatformDSH))
	if err != nil {
		t.Fatal(err)
	}
	conv, err := NewDSHScanner().Read(items[0])
	if err != nil {
		t.Fatal(err)
	}
	warned := false
	for _, w := range conv.Warnings {
		if strings.Contains(w, "newer than the supported") {
			warned = true
		}
	}
	if !warned {
		t.Fatalf("a newer session format must warn, got %v", conv.Warnings)
	}
	if len(conv.Messages) != 1 {
		t.Fatalf("known records must still import on an unknown version, got %d", len(conv.Messages))
	}
}

func TestDSHScanMissingRootIsNotAnError(t *testing.T) {
	t.Setenv("DSH_HOME", filepath.Join(t.TempDir(), "absent"))
	items, err := NewDSHScanner().Scan(DefaultRoots(PlatformDSH))
	if err != nil {
		t.Fatalf("a machine without DSH must scan cleanly, got %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("expected no sessions, got %v", items)
	}
}

func TestDSHResolveEvtFromDotEnv(t *testing.T) {
	home := t.TempDir()
	t.Setenv("DSH_HOME", home)
	if err := os.WriteFile(filepath.Join(home, ".env"), []byte("EVERME_API_BASE=https://api.example.com\nEVERME_AGENT_ID=agt_1\nEVERME_AGENT_TOKEN=evt_test_token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	tok, err := ResolveEvt(PlatformDSH)
	if err != nil {
		t.Fatal(err)
	}
	if tok != "evt_test_token" {
		t.Fatalf("unexpected token %q", tok)
	}
}
