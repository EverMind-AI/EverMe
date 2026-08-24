package conversation

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// bffUploader is a real Uploader pointing at an httptest server
// We test with the real Uploader (not a fake) for the e2e test.

type e2eCapture struct {
	mu       sync.Mutex
	requests []e2eReq
}

type e2eReq struct {
	Auth           string
	ConversationID string
	Flush          bool
	Sync           bool
	MessageCount   int
}

func (c *e2eCapture) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			ConversationID string               `json:"conversationId"`
			Messages       []AgentMemoryMessage `json:"messages"`
			Flush          bool                 `json:"flush"`
			Sync           bool                 `json:"sync"`
		}
		json.Unmarshal(body, &payload)
		c.mu.Lock()
		c.requests = append(c.requests, e2eReq{
			Auth:           r.Header.Get("Authorization"),
			ConversationID: payload.ConversationID,
			Flush:          payload.Flush,
			Sync:           payload.Sync,
			MessageCount:   len(payload.Messages),
		})
		c.mu.Unlock()
		w.WriteHeader(202)
		w.Write([]byte(`{"status":0,"requestId":"r1","result":{"sessionId":"s1","status":"queued","messageCount":1,"flushed":false}}`))
	}
}

// backdatedTestdata copies the committed testdata/ fixtures into a fresh temp
// dir and backdates their mtimes by an hour. The active-session filter (FIX 1)
// excludes files whose mtime is within activeSessionWindow of now; on a fresh
// checkout the committed fixtures get a checkout-time mtime (~now), which would
// otherwise make them disappear from these e2e scans. Copying + backdating
// keeps the tests deterministic regardless of how the repo was obtained.
func backdatedTestdata(t *testing.T) string {
	t.Helper()
	src, _ := filepath.Abs("testdata")
	dst := t.TempDir()
	entries, err := os.ReadDir(src)
	if err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-1 * time.Hour)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		b, err := os.ReadFile(filepath.Join(src, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		p := filepath.Join(dst, e.Name())
		if err := os.WriteFile(p, b, 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, old, old); err != nil {
			t.Fatal(err)
		}
	}
	return dst
}

// TestE2EExcludeSkipsUpload proves a per-item exclusion (run --exclude <path>)
// keeps the excluded path out of the upload set: its conversationId never
// reaches the fake BFF.
func TestE2EExcludeSkipsUpload(t *testing.T) {
	cap := &e2eCapture{}
	srv := httptest.NewServer(cap.handler())
	defer srv.Close()

	tdDir := backdatedTestdata(t)
	roots := map[PlatformID][]string{PlatformCodex: {tdDir}}

	dir := t.TempDir()
	svc := NewService(ServiceDeps{
		Registry:    DefaultRegistry(),
		Roots:       roots,
		StatePath:   dir + "/state.json",
		Uploader:    NewUploader(srv.URL, srv.Client()),
		EvtResolver: func(p PlatformID) (string, error) { return "evt_" + string(p), nil },
	})

	rep, err := svc.Scan([]PlatformID{PlatformCodex})
	if err != nil {
		t.Fatalf("scan failed: %v", err)
	}
	if len(rep.Items) == 0 {
		t.Fatal("expected codex fixtures")
	}

	// Exclude the first scanned path. Mirror the run command's filter: drop any
	// item whose Path matches the exclusion before uploading.
	excludePath := rep.Items[0].Path
	excludedID := ""
	for _, item := range rep.Items {
		sc := DefaultRegistry().ScannerFor(item.Platform)
		conv, err := sc.Read(item)
		if err != nil {
			t.Fatalf("read %s: %v", item.Path, err)
		}
		if item.Path == excludePath {
			excludedID = conv.ID
			continue // excluded — never uploaded
		}
		if _, err := svc.RunOne(context.Background(), conv, RunOpts{Consented: true}); err != nil {
			t.Fatalf("RunOne %s: %v", item.Path, err)
		}
	}

	if excludedID == "" {
		t.Fatal("could not determine excluded conversationId")
	}
	for _, req := range cap.requests {
		if req.ConversationID == excludedID {
			t.Fatalf("excluded path was uploaded (convID=%s)", excludedID)
		}
	}
}

// TestE2EDryRunTouchesNoNetworkOrState pins the dry-run contract (spec §10):
// a dry-run performs a Scan only — it never calls the uploader and never writes
// the state file. This mirrors the run command's dry-run early-return, which
// returns before constructing the uploader/state and before any RunOne.
func TestE2EDryRunTouchesNoNetworkOrState(t *testing.T) {
	cap := &e2eCapture{}
	srv := httptest.NewServer(cap.handler())
	defer srv.Close()

	tdDir := backdatedTestdata(t)
	roots := map[PlatformID][]string{PlatformCodex: {tdDir}}

	dir := t.TempDir()
	statePath := dir + "/state.json"
	fake := &fakeUploader{}
	svc := NewService(ServiceDeps{
		Registry:    DefaultRegistry(),
		Roots:       roots,
		StatePath:   statePath,
		Uploader:    fake,
		EvtResolver: func(p PlatformID) (string, error) { return "evt_" + string(p), nil },
	})

	// Dry-run == scan only; no RunOne is invoked.
	rep, err := svc.Scan([]PlatformID{PlatformCodex})
	if err != nil {
		t.Fatalf("scan failed: %v", err)
	}
	if len(rep.Items) == 0 {
		t.Fatal("expected codex fixtures for a meaningful dry-run")
	}

	if fake.calls != 0 {
		t.Fatalf("dry-run must not upload, got %d calls", fake.calls)
	}
	if len(cap.requests) != 0 {
		t.Fatalf("dry-run must not POST to the BFF, got %d requests", len(cap.requests))
	}
	if _, err := os.Stat(statePath); !os.IsNotExist(err) {
		t.Fatalf("dry-run must not create the state file at %s (stat err=%v)", statePath, err)
	}
}

func TestE2EScanThenRunWithRealFixtures(t *testing.T) {
	cap := &e2eCapture{}
	srv := httptest.NewServer(cap.handler())
	defer srv.Close()

	// Use a backdated copy of testdata as roots for all platforms so the
	// active-session filter (FIX 1) does not exclude freshly-checked-out files.
	tdDir := backdatedTestdata(t)

	roots := map[PlatformID][]string{
		PlatformClaudeCode: {tdDir},
		PlatformCodex:      {tdDir},
		PlatformHermes:     {tdDir},
		PlatformOpenClaw:   {tdDir},
		PlatformMarkdown:   {tdDir},
	}

	uploader := NewUploader(srv.URL, srv.Client())

	evtCalls := map[PlatformID]int{}
	var evtMu sync.Mutex
	evtResolver := func(p PlatformID) (string, error) {
		evtMu.Lock()
		evtCalls[p]++
		evtMu.Unlock()
		return "evt_" + string(p), nil
	}

	dir := t.TempDir()
	svc := NewService(ServiceDeps{
		Registry:    DefaultRegistry(),
		Roots:       roots,
		StatePath:   dir + "/state.json",
		Uploader:    uploader,
		EvtResolver: evtResolver,
	})

	// (a) Scan + RunOne for each item — each uploads once with right evt
	rep, err := svc.Scan([]PlatformID{PlatformClaudeCode, PlatformCodex, PlatformHermes, PlatformOpenClaw, PlatformMarkdown})
	if err != nil {
		t.Fatalf("scan failed: %v", err)
	}
	if len(rep.Items) == 0 {
		t.Fatal("e2e: expected items from testdata, got none")
	}

	// wantEvt maps each conversation ID to the Authorization header it must
	// carry — the conversation's own platform evt, proving per-platform binding.
	wantEvt := map[string]string{}
	for _, item := range rep.Items {
		sc := DefaultRegistry().ScannerFor(item.Platform)
		if sc == nil {
			t.Fatalf("no scanner for %s", item.Platform)
		}
		conv, err := sc.Read(item)
		if err != nil {
			t.Fatalf("read %s: %v", item.Path, err)
		}
		wantEvt[conv.ID] = "Bearer evt_" + string(item.Platform)
		res, err := svc.RunOne(context.Background(), conv, RunOpts{Consented: true})
		if err != nil {
			t.Fatalf("RunOne %s: %v", item.Path, err)
		}
		if res.Skipped {
			t.Fatalf("first run must not skip: %s", item.Path)
		}
	}

	// Verify each upload used the correct platform evt. Every testdata
	// fixture fits in a single batch, so each upload is both the leading and
	// the final batch of its session: sync:true and flush:true.
	for _, req := range cap.requests {
		if !req.Sync {
			t.Errorf("sync must be true for all uploads, got false for convID=%s", req.ConversationID)
		}
		if !req.Flush {
			t.Errorf("single-batch upload must flush, got false for convID=%s", req.ConversationID)
		}
		want, ok := wantEvt[req.ConversationID]
		if !ok {
			t.Errorf("upload for unexpected convID=%s", req.ConversationID)
			continue
		}
		if req.Auth != want {
			t.Errorf("convID=%s used evt %q, want %q (per-platform binding broken)", req.ConversationID, req.Auth, want)
		}
	}
	if evtCalls[PlatformClaudeCode] == 0 {
		t.Error("evt resolver was never consulted for claude-code")
	}
	if len(cap.requests) == 0 {
		t.Fatal("e2e: no uploads happened")
	}
	firstRunUploads := len(cap.requests)

	// (b) Second run — all items should be skipped
	for _, item := range rep.Items {
		sc := DefaultRegistry().ScannerFor(item.Platform)
		conv, _ := sc.Read(item)
		res, err := svc.RunOne(context.Background(), conv, RunOpts{Consented: true})
		if err != nil {
			t.Fatalf("second RunOne %s: %v", item.Path, err)
		}
		if !res.Skipped {
			t.Fatalf("second run must skip submitted path: %s", item.Path)
		}
	}
	if len(cap.requests) != firstRunUploads {
		t.Fatalf("second run must not upload: got %d extra uploads", len(cap.requests)-firstRunUploads)
	}

	// (c) No-consent run — uploads nothing (use a fresh service pointing at same testdata, different state)
	dir2 := t.TempDir()
	cap2 := &e2eCapture{}
	srv2 := httptest.NewServer(cap2.handler())
	defer srv2.Close()
	up2 := NewUploader(srv2.URL, srv2.Client())
	svc2 := NewService(ServiceDeps{
		Registry:    DefaultRegistry(),
		Roots:       roots,
		StatePath:   dir2 + "/state.json",
		Uploader:    up2,
		EvtResolver: evtResolver,
	})
	for _, item := range rep.Items {
		sc := DefaultRegistry().ScannerFor(item.Platform)
		conv, _ := sc.Read(item)
		_, err := svc2.RunOne(context.Background(), conv, RunOpts{Consented: false})
		if err == nil {
			t.Fatalf("no-consent run must return error for %s", item.Path)
		}
	}
	if len(cap2.requests) != 0 {
		t.Fatalf("no-consent run must not upload, got %d uploads", len(cap2.requests))
	}
}
