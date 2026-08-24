package conversation

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestUploaderUsesTargetEvtAndSingleBatchFlushes(t *testing.T) {
	var gotAuth string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &gotBody)
		w.WriteHeader(202)
		// Real BFF envelope: root status is an int errno; the async status
		// lives in result.status (see server/pkg/core + v1.AgentMemoryResponse).
		w.Write([]byte(`{"status":0,"requestId":"r1","result":{"sessionId":"s1","status":"queued","messageCount":1,"flushed":false}}`))
	}))
	defer srv.Close()

	up := NewUploader(srv.URL, srv.Client())
	conv := &Conversation{ID: "import-claude-code-x", Messages: []AgentMemoryMessage{{Role: "user", Timestamp: 1, Content: "hi"}}}
	status, err := up.Upload(t.Context(), "evt_target123", conv)
	if err != nil {
		t.Fatal(err)
	}
	if status != "queued" {
		t.Fatalf("status=%q", status)
	}
	if gotAuth != "Bearer evt_target123" {
		t.Fatalf("must use target evt, got %q", gotAuth)
	}
	// A conversation with a single batch is both the leading and the final
	// batch, so it must carry sync:true and flush:true.
	if gotBody["flush"] != true {
		t.Fatalf("single batch must flush, got %v", gotBody["flush"])
	}
	if gotBody["sync"] != true {
		t.Fatalf("single batch must be sync, got %v", gotBody["sync"])
	}
	if gotBody["conversationId"] != "import-claude-code-x" {
		t.Fatalf("conversationId mismatch: %v", gotBody["conversationId"])
	}
}

func TestUploaderBatchesLargeConversation(t *testing.T) {
	var mu sync.Mutex
	var reqs []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var body map[string]any
		json.Unmarshal(b, &body)
		body["_auth"] = r.Header.Get("Authorization")
		mu.Lock()
		reqs = append(reqs, body)
		mu.Unlock()
		w.WriteHeader(202)
		w.Write([]byte(`{"status":0,"result":{"status":"queued"}}`))
	}))
	defer srv.Close()

	up := NewUploader(srv.URL, srv.Client())
	up.maxBatchBytes = 9000 // force splitting on small messages

	var msgs []AgentMemoryMessage
	for i := 0; i < 5; i++ {
		msgs = append(msgs, AgentMemoryMessage{Role: "tool", Timestamp: int64(i + 1), ToolCallID: "c", Content: strings.Repeat("x", 4000)})
	}
	conv := &Conversation{ID: "import-codex-big", Messages: msgs}

	status, err := up.Upload(t.Context(), "evt_target123", conv)
	if err != nil {
		t.Fatal(err)
	}
	if status != "queued" {
		t.Fatalf("status=%q", status)
	}

	if len(reqs) < 2 {
		t.Fatalf("large conversation must be POSTed in >1 batch, got %d", len(reqs))
	}
	totalMsgs := 0
	for i, b := range reqs {
		final := i == len(reqs)-1
		if b["conversationId"] != "import-codex-big" {
			t.Fatalf("batch %d conversationId mismatch: %v", i, b["conversationId"])
		}
		wantFlush := final
		if b["flush"] != wantFlush {
			t.Fatalf("batch %d flush=%v, want %v", i, b["flush"], wantFlush)
		}
		if b["sync"] != true {
			t.Fatalf("batch %d sync must be true, got %v", i, b["sync"])
		}
		if b["_auth"] != "Bearer evt_target123" {
			t.Fatalf("batch %d must use target evt, got %v", i, b["_auth"])
		}
		if arr, ok := b["messages"].([]any); ok {
			totalMsgs += len(arr)
		}
	}
	if totalMsgs != len(msgs) {
		t.Fatalf("batches must cover all %d messages, got %d", len(msgs), totalMsgs)
	}
}

func TestUploadSyncLeadingFlushFinal(t *testing.T) {
	var got []agentMemoryReq
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req agentMemoryReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode: %v", err)
		}
		got = append(got, req)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":0,"result":{"status":"success","flushed":true}}`)
	}))
	defer srv.Close()

	u := NewUploader(srv.URL, srv.Client())
	u.maxBatchBytes = 1 // force one batch per message

	conv := &Conversation{
		ID: "conv-1",
		Messages: []AgentMemoryMessage{
			{Role: "user", Content: "hello"},
			{Role: "assistant", Content: "world"},
			{Role: "user", Content: "bye"},
		},
	}
	status, err := u.Upload(context.Background(), "evt_x", conv)
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("want 3 batches, got %d", len(got))
	}
	for i, req := range got {
		final := i == len(got)-1
		if req.Flush != final {
			t.Errorf("batch %d: flush=%v, want %v", i, req.Flush, final)
		}
		if !req.Sync {
			t.Errorf("batch %d: sync=false, want true", i)
		}
	}
	if status != "success" {
		t.Errorf("status=%q, want success", status)
	}
}

func TestUploadSingleBatchFlushes(t *testing.T) {
	var got []agentMemoryReq
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req agentMemoryReq
		_ = json.NewDecoder(r.Body).Decode(&req)
		got = append(got, req)
		fmt.Fprint(w, `{"status":0,"result":{"status":"success","flushed":true}}`)
	}))
	defer srv.Close()

	u := NewUploader(srv.URL, srv.Client())
	conv := &Conversation{ID: "conv-1", Messages: []AgentMemoryMessage{{Role: "user", Content: "hi"}}}
	if _, err := u.Upload(context.Background(), "evt_x", conv); err != nil {
		t.Fatalf("upload: %v", err)
	}
	if len(got) != 1 || !got[0].Flush || !got[0].Sync {
		t.Fatalf("single batch must be sync+flush, got %+v", got)
	}
}

func TestUploadAsyncSendsEveryBatchWithoutSyncOrFlush(t *testing.T) {
	var mu sync.Mutex
	var reqs []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var body map[string]any
		json.Unmarshal(b, &body)
		body["_auth"] = r.Header.Get("Authorization")
		mu.Lock()
		reqs = append(reqs, body)
		mu.Unlock()
		w.WriteHeader(202)
		w.Write([]byte(`{"status":0,"result":{"status":"queued"}}`))
	}))
	defer srv.Close()

	up := NewUploader(srv.URL, srv.Client())
	up.maxBatchBytes = 9000 // force splitting on small messages

	var msgs []AgentMemoryMessage
	for i := 0; i < 5; i++ {
		msgs = append(msgs, AgentMemoryMessage{Role: "tool", Timestamp: int64(i + 1), ToolCallID: "c", Content: strings.Repeat("x", 4000)})
	}
	conv := &Conversation{ID: "import-codex-async", Messages: msgs}

	status, err := up.UploadAsync(t.Context(), "evt_target123", conv)
	if err != nil {
		t.Fatal(err)
	}
	if status != "queued" {
		t.Fatalf("status=%q", status)
	}
	if len(reqs) < 2 {
		t.Fatalf("large conversation must be POSTed in >1 batch, got %d", len(reqs))
	}
	totalMsgs := 0
	for i, b := range reqs {
		// The async path must never set sync or flush on ANY batch: flush on
		// the tail would race the earlier async adds upstream (the silent-drop
		// failure the sync path exists to avoid). The flush is issued later
		// via FlushSession, after every add has had time to land.
		if _, ok := b["sync"]; ok {
			t.Fatalf("batch %d must omit sync, got %v", i, b["sync"])
		}
		if b["flush"] != false {
			t.Fatalf("batch %d flush must be false, got %v", i, b["flush"])
		}
		if b["_auth"] != "Bearer evt_target123" {
			t.Fatalf("batch %d must use target evt, got %v", i, b["_auth"])
		}
		if arr, ok := b["messages"].([]any); ok {
			totalMsgs += len(arr)
		}
	}
	if totalMsgs != len(msgs) {
		t.Fatalf("batches must cover all %d messages, got %d", len(msgs), totalMsgs)
	}
}

func TestFlushSessionPostsFlushOnlyRequest(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &gotBody)
		gotBody["_auth"] = r.Header.Get("Authorization")
		w.WriteHeader(200)
		w.Write([]byte(`{"status":0,"result":{"sessionId":"s1","status":"extracted","flushed":true}}`))
	}))
	defer srv.Close()

	up := NewUploader(srv.URL, srv.Client())
	status, err := up.FlushSession(t.Context(), "evt_target123", "import-codex-async")
	if err != nil {
		t.Fatal(err)
	}
	if status != "extracted" {
		t.Fatalf("status=%q", status)
	}
	if gotBody["flush"] != true {
		t.Fatalf("flush-only request must set flush, got %v", gotBody["flush"])
	}
	if msgs, ok := gotBody["messages"].([]any); ok && len(msgs) != 0 {
		t.Fatalf("flush-only request must carry no messages, got %d", len(msgs))
	}
	if gotBody["conversationId"] != "import-codex-async" {
		t.Fatalf("conversationId mismatch: %v", gotBody["conversationId"])
	}
	if gotBody["_auth"] != "Bearer evt_target123" {
		t.Fatalf("must use target evt, got %v", gotBody["_auth"])
	}
}
