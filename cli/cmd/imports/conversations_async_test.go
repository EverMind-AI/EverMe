package imports

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// asyncCapture records every agent-memory request in arrival order so the
// test can assert the two-phase contract: every add for every session is
// sent before the first flush.
type asyncCapture struct {
	mu       sync.Mutex
	requests []asyncReq
}

type asyncReq struct {
	ConversationID string
	Flush          bool
	SyncSet        bool
	MessageCount   int
}

func (c *asyncCapture) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			ConversationID string           `json:"conversationId"`
			Messages       []map[string]any `json:"messages"`
			Flush          bool             `json:"flush"`
			Sync           *bool            `json:"sync"`
		}
		json.Unmarshal(body, &payload)
		c.mu.Lock()
		c.requests = append(c.requests, asyncReq{
			ConversationID: payload.ConversationID,
			Flush:          payload.Flush,
			SyncSet:        payload.Sync != nil,
			MessageCount:   len(payload.Messages),
		})
		c.mu.Unlock()
		w.WriteHeader(202)
		if payload.Flush {
			w.Write([]byte(`{"status":0,"result":{"sessionId":"s1","status":"extracted","flushed":true}}`))
			return
		}
		w.Write([]byte(`{"status":0,"result":{"sessionId":"s1","status":"queued","messageCount":1,"flushed":false}}`))
	}
}

// TestRunAsyncTwoPhaseUploadsThenFlushes drives the real command with --async
// against a capturing BFF: phase 1 must send every session's adds without
// sync/flush, and only after all adds are sent may the per-session flush-only
// requests go out (deferring flushes is what keeps them from racing async
// adds that have not landed upstream).
func TestRunAsyncTwoPhaseUploadsThenFlushes(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "config"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, "data"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, "cache"))

	cap := &asyncCapture{}
	srv := httptest.NewServer(cap.handler())
	defer srv.Close()
	t.Setenv("EVERCLI_API_BASE_URL", srv.URL)

	// The codex evt lives in $CODEX_HOME/config.toml under
	// [mcp_servers.everme.env] (see resolveCodexEvt).
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)
	cfg := "[mcp_servers.everme]\n[mcp_servers.everme.env]\nEVERME_AGENT_TOKEN = \"evt_async_test\"\n"
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}

	root := t.TempDir()
	sessions := map[string]string{
		"one.jsonl": `{"timestamp":1749001000000,"type":"session_meta","payload":{}}
{"timestamp":1749001001000,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello one"}]}}
`,
		"two.jsonl": `{"timestamp":1759001000000,"type":"session_meta","payload":{}}
{"timestamp":1759001001000,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello two"}]}}
`,
	}
	old := time.Now().Add(-1 * time.Hour)
	for name, content := range sessions {
		p := filepath.Join(root, name)
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		os.Chtimes(p, old, old)
	}

	cmd := newConversationsRun()
	var out, errOut bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&errOut)
	cmd.SetArgs([]string{
		"codex",
		"--path", "codex=" + root,
		"--no-prompt",
		"--async",
	})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("async run must not error: %v (stderr=%s)", err, errOut.String())
	}

	cap.mu.Lock()
	reqs := append([]asyncReq(nil), cap.requests...)
	cap.mu.Unlock()

	if len(reqs) != 4 {
		t.Fatalf("want 2 adds + 2 flushes = 4 requests, got %d: %+v", len(reqs), reqs)
	}
	// Phase 1: adds only — no sync, no flush, carrying the messages.
	addIDs := map[string]bool{}
	for i, r := range reqs[:2] {
		if r.Flush || r.SyncSet {
			t.Fatalf("request %d must be an async add (no sync/flush), got %+v", i, r)
		}
		if r.MessageCount == 0 {
			t.Fatalf("add request %d must carry messages, got %+v", i, r)
		}
		addIDs[r.ConversationID] = true
	}
	// Phase 2: flush-only — one per session, no messages, matching the adds.
	for i, r := range reqs[2:] {
		if !r.Flush || r.MessageCount != 0 {
			t.Fatalf("request %d must be flush-only, got %+v", i+2, r)
		}
		if !addIDs[r.ConversationID] {
			t.Fatalf("flush %d targets unknown conversation %q", i+2, r.ConversationID)
		}
		delete(addIDs, r.ConversationID)
	}
	if len(addIDs) != 0 {
		t.Fatalf("every added session must be flushed; missing flushes for %v", addIDs)
	}

	// Reporting: adds surface as queued, flushes as extracted.
	if !strings.Contains(out.String(), "queued") {
		t.Fatalf("phase-1 status must be reported, got:\n%s", out.String())
	}
	if !strings.Contains(out.String(), "extracted") {
		t.Fatalf("phase-2 flush status must be reported, got:\n%s", out.String())
	}
}
