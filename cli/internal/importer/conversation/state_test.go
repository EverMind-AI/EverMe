package conversation

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A corrupt/unparseable state file must not brick every import. LoadState
// backs the bad file up to <path>.corrupt and returns a fresh empty state
// (recording the backup path), rather than returning a hard error that the
// run loop would surface on every single session.
func TestLoadStateRecoversFromCorrupt(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	// Mimic the real corruption: two concatenated JSON objects.
	corrupt := `{"entries":{"a":{"status":"failed"}}}{"entries":{"b":{}}}`
	if err := os.WriteFile(path, []byte(corrupt), 0o644); err != nil {
		t.Fatal(err)
	}

	s, err := LoadState(path, "")
	if err != nil {
		t.Fatalf("LoadState must recover from a corrupt file, got error: %v", err)
	}
	if len(s.Entries) != 0 {
		t.Fatalf("recovered state must start empty, got %d entries", len(s.Entries))
	}
	if s.RecoveredFrom == "" {
		t.Fatal("recovered state must record the backup path in RecoveredFrom")
	}
	if _, statErr := os.Stat(s.RecoveredFrom); statErr != nil {
		t.Fatalf("corrupt file must be preserved at backup path %s: %v", s.RecoveredFrom, statErr)
	}
	got, _ := os.ReadFile(s.RecoveredFrom)
	if string(got) != corrupt {
		t.Fatalf("backup must contain the original corrupt bytes")
	}
	// A subsequent save+reload round-trips cleanly.
	s.MarkSubmitted("/x/a.jsonl", "cid")
	if err := s.Save(); err != nil {
		t.Fatal(err)
	}
	if s2, err := LoadState(path, ""); err != nil || !s2.ShouldSkip("/x/a.jsonl") {
		t.Fatalf("post-recovery save must round-trip: err=%v", err)
	}
}

func TestStateSubmittedSkips(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	s, err := LoadState(path, "")
	if err != nil {
		t.Fatal(err)
	}
	if s.ShouldSkip("/x/a.jsonl") {
		t.Fatal("fresh path must not skip")
	}
	s.MarkSubmitted("/x/a.jsonl", "import-claude-code-aaa")
	if err := s.Save(); err != nil {
		t.Fatal(err)
	}
	// reload from disk
	s2, _ := LoadState(path, "")
	if !s2.ShouldSkip("/x/a.jsonl") {
		t.Fatal("submitted path must skip after reload")
	}
	// failed path is retryable (not skipped)
	s2.MarkFailed("/x/b.jsonl", "net error")
	if s2.ShouldSkip("/x/b.jsonl") {
		t.Fatal("failed path must be retryable")
	}
}

// TestStateScopeSeparatesAccountsAndEnvironments is the regression for
// the 2026-08-17 review item 1.2.3. The ledger key was platform:path and
// the file is a single global one under DataDir, so switching account or
// api_base made the new identity inherit the old one's "already
// submitted" marks: every session it had never uploaded was silently
// skipped, and the fresh account's memory started out incomplete.
func TestStateScopeSeparatesAccountsAndEnvironments(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	item := Item{Platform: PlatformCodex, Path: "/sessions/a.jsonl"}
	key := ItemStateKey(item)

	first, err := LoadState(path, StateScope("https://api.everme.evermind.ai", "acc_one"))
	if err != nil {
		t.Fatal(err)
	}
	first.MarkSubmitted(key, "conv-1")
	if err := first.Save(); err != nil {
		t.Fatal(err)
	}

	sameAccount, err := LoadState(path, StateScope("https://api.everme.evermind.ai", "acc_one"))
	if err != nil {
		t.Fatal(err)
	}
	if !sameAccount.ShouldSkip(key) {
		t.Fatal("the account that uploaded it must still skip it")
	}

	otherAccount, err := LoadState(path, StateScope("https://api.everme.evermind.ai", "acc_two"))
	if err != nil {
		t.Fatal(err)
	}
	if otherAccount.ShouldSkip(key) {
		t.Fatal("a different account has never uploaded this session")
	}

	otherEnv, err := LoadState(path, StateScope("https://api.dev.everme.evermind.ai", "acc_one"))
	if err != nil {
		t.Fatal(err)
	}
	if otherEnv.ShouldSkip(key) {
		t.Fatal("the same account on another environment has never uploaded this session")
	}
}

// TestStateScopeDoesNotLeakIdentity: the ledger sits in a plain JSON file,
// so the scope must be a digest rather than the account id or api base.
func TestStateScopeDoesNotLeakIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	st, err := LoadState(path, StateScope("https://api.everme.evermind.ai", "acc_secret"))
	if err != nil {
		t.Fatal(err)
	}
	st.MarkSubmitted(ItemStateKey(Item{Platform: PlatformCodex, Path: "/a.jsonl"}), "cid")
	if err := st.Save(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"acc_secret", "everme.evermind.ai"} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("state file must not carry %q verbatim: %s", secret, raw)
		}
	}
}

// TestLoadStateAdoptsLegacyEntries: ledgers written before scoping have
// unscoped keys. Adopt them for whoever is logged in now and say so
// once. Dropping them instead would re-upload every past session and
// duplicate it upstream, which is worse than a skip the user can undo
// with --reimport.
func TestLoadStateAdoptsLegacyEntries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	legacy := `{"entries":{"codex:/sessions/a.jsonl":{"status":"submitted","conversationId":"cid"}}}`
	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}

	scope := StateScope("https://api.everme.evermind.ai", "acc_one")
	st, err := LoadState(path, scope)
	if err != nil {
		t.Fatal(err)
	}
	if st.AdoptedLegacyEntries != 1 {
		t.Fatalf("expected 1 adopted legacy entry, got %d", st.AdoptedLegacyEntries)
	}
	key := ItemStateKey(Item{Platform: PlatformCodex, Path: "/sessions/a.jsonl"})
	if !st.ShouldSkip(key) {
		t.Fatal("an adopted legacy entry must still count as submitted")
	}
	if err := st.Save(); err != nil {
		t.Fatal(err)
	}
	// Re-loading the migrated file adopts nothing more, and another
	// identity is unaffected by the adoption.
	again, err := LoadState(path, scope)
	if err != nil {
		t.Fatal(err)
	}
	if again.AdoptedLegacyEntries != 0 {
		t.Fatalf("migration must run once, got %d", again.AdoptedLegacyEntries)
	}
	other, err := LoadState(path, StateScope("https://api.everme.evermind.ai", "acc_two"))
	if err != nil {
		t.Fatal(err)
	}
	if other.ShouldSkip(key) {
		t.Fatal("adoption must not hand the entry to every identity")
	}
}
