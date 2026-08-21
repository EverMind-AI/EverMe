package conversation

import (
	"context"
	"testing"
)

// fakeAsyncUploader records the order of async adds and flushes so tests can
// assert the two-phase contract (all adds before any flush is the cmd layer's
// job; per-call routing and retry are the service's).
type fakeAsyncUploader struct {
	fakeUploader
	asyncCalls    int
	flushCalls    int
	flushConvIDs  []string
	flushStatuses []string // consumed per FlushSession call; last repeats
	flushErr      error
}

func (f *fakeAsyncUploader) UploadAsync(_ context.Context, evt string, _ *Conversation) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	f.asyncCalls++
	f.lastEvt = evt
	return "queued", nil
}

func (f *fakeAsyncUploader) FlushSession(_ context.Context, _ string, conversationID string) (string, error) {
	if f.flushErr != nil {
		return "", f.flushErr
	}
	i := f.flushCalls
	f.flushCalls++
	f.flushConvIDs = append(f.flushConvIDs, conversationID)
	if i >= len(f.flushStatuses) {
		i = len(f.flushStatuses) - 1
	}
	return f.flushStatuses[i], nil
}

func TestRunOneAsyncUploadsWithoutFlushAndMarksSubmitted(t *testing.T) {
	dir := t.TempDir()
	fake := &fakeAsyncUploader{}
	svc := NewService(ServiceDeps{
		Registry:    DefaultRegistry(),
		StatePath:   dir + "/state.json",
		Uploader:    fake,
		EvtResolver: func(p PlatformID) (string, error) { return "evt_" + string(p), nil },
	})
	conv := &Conversation{
		ID:       "import-claude-code-async",
		Item:     Item{Platform: PlatformClaudeCode, Path: "/x/async.jsonl"},
		Messages: []AgentMemoryMessage{{Role: "user", Timestamp: 1, Content: "hi"}},
	}

	res, err := svc.RunOne(t.Context(), conv, RunOpts{Consented: true, Async: true})
	if err != nil {
		t.Fatal(err)
	}
	if fake.asyncCalls != 1 || fake.calls != 0 {
		t.Fatalf("async mode must use UploadAsync only: async=%d sync=%d", fake.asyncCalls, fake.calls)
	}
	if res.Status != "queued" {
		t.Fatalf("status=%q", res.Status)
	}
	// The async ACK must NOT mark submitted yet: a run interrupted between
	// the add phase and the flush phase would otherwise leave the session
	// queued-but-never-flushed AND idempotently skipped on every re-run —
	// extraction silently never happens. Submitted is FlushOne's job.
	res2, err := svc.RunOne(t.Context(), conv, RunOpts{Consented: true, Async: true})
	if err != nil {
		t.Fatal(err)
	}
	if res2.Skipped {
		t.Fatal("un-flushed async session must not be idempotently skipped")
	}

	fake.flushStatuses = []string{"extracted"}
	if _, err := svc.FlushOne(t.Context(), conv, 0); err != nil {
		t.Fatal(err)
	}
	// Only the flush completes the session: now the re-run must skip.
	res3, err := svc.RunOne(t.Context(), conv, RunOpts{Consented: true, Async: true})
	if err != nil {
		t.Fatal(err)
	}
	if !res3.Skipped {
		t.Fatal("flushed session must skip on re-run")
	}
}

func TestFlushOneRetriesOnceOnNoExtraction(t *testing.T) {
	dir := t.TempDir()
	fake := &fakeAsyncUploader{flushStatuses: []string{"no_extraction", "extracted"}}
	svc := NewService(ServiceDeps{
		Registry:    DefaultRegistry(),
		StatePath:   dir + "/state.json",
		Uploader:    fake,
		EvtResolver: func(p PlatformID) (string, error) { return "evt_" + string(p), nil },
	})
	conv := &Conversation{
		ID:   "import-claude-code-async",
		Item: Item{Platform: PlatformClaudeCode, Path: "/x/async.jsonl"},
	}

	res, err := svc.FlushOne(t.Context(), conv, 0) // 0 retry delay in tests
	if err != nil {
		t.Fatal(err)
	}
	if fake.flushCalls != 2 {
		t.Fatalf("no_extraction must trigger exactly one retry, got %d calls", fake.flushCalls)
	}
	if res.Status != "extracted" {
		t.Fatalf("status=%q", res.Status)
	}
}

func TestFlushOneReportsExtractionPendingWhenRetryStillFails(t *testing.T) {
	dir := t.TempDir()
	fake := &fakeAsyncUploader{flushStatuses: []string{"no_extraction", "no_extraction"}}
	svc := NewService(ServiceDeps{
		Registry:    DefaultRegistry(),
		StatePath:   dir + "/state.json",
		Uploader:    fake,
		EvtResolver: func(p PlatformID) (string, error) { return "evt_" + string(p), nil },
	})
	conv := &Conversation{
		ID:   "import-claude-code-async",
		Item: Item{Platform: PlatformClaudeCode, Path: "/x/async.jsonl"},
	}

	res, err := svc.FlushOne(t.Context(), conv, 0)
	if err != nil {
		t.Fatal(err)
	}
	if fake.flushCalls != 2 {
		t.Fatalf("expected exactly 2 flush attempts, got %d", fake.flushCalls)
	}
	if res.Status != "extraction_pending" {
		t.Fatalf("persistent no_extraction must report extraction_pending, got %q", res.Status)
	}
}
