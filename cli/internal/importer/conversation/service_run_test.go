package conversation

import (
	"context"
	"fmt"
	"testing"
)

type fakeUploader struct {
	calls   int
	lastEvt string
	err     error
}

func (f *fakeUploader) Upload(_ context.Context, evt string, _ *Conversation) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	f.calls++
	f.lastEvt = evt
	return "queued", nil
}

// Async-path stubs: sync-path tests must never reach these.
func (f *fakeUploader) UploadAsync(context.Context, string, *Conversation) (string, error) {
	return "", fmt.Errorf("unexpected UploadAsync call in sync-path test")
}

func (f *fakeUploader) FlushSession(context.Context, string, string) (string, error) {
	return "", fmt.Errorf("unexpected FlushSession call in sync-path test")
}

func TestRunSkipsSubmittedAndRequiresConsent(t *testing.T) {
	dir := t.TempDir()
	fake := &fakeUploader{}
	svc := NewService(ServiceDeps{
		Registry:    DefaultRegistry(),
		StatePath:   dir + "/state.json",
		Uploader:    fake,
		EvtResolver: func(p PlatformID) (string, error) { return "evt_" + string(p), nil },
	})
	conv := &Conversation{
		ID:       "import-claude-code-x",
		Item:     Item{Platform: PlatformClaudeCode, Path: "/x/a.jsonl"},
		Messages: []AgentMemoryMessage{{Role: "user", Timestamp: 1, Content: "hi"}},
	}

	// no consent -> refuse, no upload
	if _, err := svc.RunOne(t.Context(), conv, RunOpts{Consented: false}); err == nil {
		t.Fatal("must refuse without consent")
	}
	if fake.calls != 0 {
		t.Fatal("must not upload without consent")
	}
	// consented -> upload with target evt, mark submitted
	if _, err := svc.RunOne(t.Context(), conv, RunOpts{Consented: true}); err != nil {
		t.Fatal(err)
	}
	if fake.calls != 1 || fake.lastEvt != "evt_claude-code" {
		t.Fatalf("calls=%d evt=%q", fake.calls, fake.lastEvt)
	}
	// second run -> skipped (submitted)
	res, err := svc.RunOne(t.Context(), conv, RunOpts{Consented: true})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Skipped {
		t.Fatal("submitted path must skip on re-run")
	}
	if fake.calls != 1 {
		t.Fatal("submitted path must not re-upload")
	}
}
