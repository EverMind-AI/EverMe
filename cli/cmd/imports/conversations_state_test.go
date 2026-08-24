package imports

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"evercli/internal/core"
	"evercli/internal/importer/conversation"
)

// ---------------------------------------------------------------------------
// annotateSubmitted
// ---------------------------------------------------------------------------

func TestAnnotateSubmittedMarksMatchingItems(t *testing.T) {
	dir := t.TempDir()
	st, err := conversation.LoadState(filepath.Join(dir, "state.json"), "")
	if err != nil {
		t.Fatal(err)
	}
	st.MarkSubmitted(conversation.ItemStateKey(conversation.Item{Platform: conversation.PlatformCodex, Path: "/a/submitted.jsonl"}), "cid-1")

	items := []conversation.Item{
		{Platform: conversation.PlatformCodex, Path: "/a/submitted.jsonl"},
		{Platform: conversation.PlatformCodex, Path: "/a/new.jsonl"},
	}
	annotateSubmitted(items, st)

	if items[0].Status != "submitted" {
		t.Fatalf("expected submitted.jsonl to be annotated submitted, got %q", items[0].Status)
	}
	if items[1].Status == "submitted" {
		t.Fatalf("new.jsonl must not be annotated submitted")
	}
}

// The same file path scanned under a different platform must not collide —
// the key incorporates platform, matching stateKey's derivation exactly.
func TestAnnotateSubmittedKeyIncludesPlatform(t *testing.T) {
	dir := t.TempDir()
	st, err := conversation.LoadState(filepath.Join(dir, "state.json"), "")
	if err != nil {
		t.Fatal(err)
	}
	st.MarkSubmitted(conversation.ItemStateKey(conversation.Item{Platform: conversation.PlatformCodex, Path: "/a/shared.jsonl"}), "cid-1")

	items := []conversation.Item{
		{Platform: conversation.PlatformClaudeCode, Path: "/a/shared.jsonl"},
	}
	annotateSubmitted(items, st)

	if items[0].Status == "submitted" {
		t.Fatal("a different platform sharing the same path must not be marked submitted")
	}
}

// A nil state (stateless fallback after a load failure) must be a no-op —
// scan/run must keep working, just without the submitted annotation.
func TestAnnotateSubmittedNilStateIsNoop(t *testing.T) {
	items := []conversation.Item{
		{Platform: conversation.PlatformCodex, Path: "/a/x.jsonl"},
	}
	annotateSubmitted(items, nil)
	if items[0].Status != "" {
		t.Fatalf("nil state must not mutate item status, got %q", items[0].Status)
	}
}

// ---------------------------------------------------------------------------
// loadIdempotencyState
// ---------------------------------------------------------------------------

// A missing state file is the common first-run case: no error, no warning,
// just an empty usable state.
func TestLoadIdempotencyStateMissingFileIsSilent(t *testing.T) {
	dir := t.TempDir()
	var errBuf bytes.Buffer
	st := loadIdempotencyState(&errBuf, filepath.Join(dir, "does-not-exist.json"), "")
	if st == nil {
		t.Fatal("missing file must yield a usable empty state, not nil")
	}
	if errBuf.Len() != 0 {
		t.Fatalf("missing file must not warn, got: %s", errBuf.String())
	}
}

// A corrupt file that LoadState recovers from must be surfaced — the same
// warning the run command already printed via EnsureStateLoaded before this
// change — since already-submitted sessions may re-upload after the reset.
func TestLoadIdempotencyStateWarnsOnCorruptRecovery(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	if err := os.WriteFile(path, []byte(`{"entries":{}}{"entries":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	var errBuf bytes.Buffer
	st := loadIdempotencyState(&errBuf, path, "")
	if st == nil {
		t.Fatal("corrupt-file recovery must still yield a usable state")
	}
	if !strings.Contains(errBuf.String(), "backed up") {
		t.Fatalf("must warn about the corrupt-state recovery, got: %s", errBuf.String())
	}
}

// A hard read error (not "file does not exist") must warn and fall back to
// stateless (nil), never fatal — scan/run must keep working.
func TestLoadIdempotencyStateWarnsOnHardErrorAndReturnsNil(t *testing.T) {
	dir := t.TempDir()
	// A directory where a file is expected forces a read error distinct from
	// "not exist" on every platform.
	badPath := filepath.Join(dir, "not-a-file")
	if err := os.Mkdir(badPath, 0o755); err != nil {
		t.Fatal(err)
	}
	var errBuf bytes.Buffer
	st := loadIdempotencyState(&errBuf, badPath, "")
	if st != nil {
		t.Fatal("hard read error must fall back to nil (stateless)")
	}
	if errBuf.Len() == 0 {
		t.Fatal("hard read error must warn on stderr")
	}
}

// ---------------------------------------------------------------------------
// dropSubmittedUnlessForce
// ---------------------------------------------------------------------------

func TestDropSubmittedUnlessForceDropsSubmitted(t *testing.T) {
	items := []conversation.Item{
		{Platform: conversation.PlatformCodex, Path: "/a.jsonl", Status: "submitted"},
		{Platform: conversation.PlatformCodex, Path: "/b.jsonl", Status: ""},
		{Platform: conversation.PlatformCodex, Path: "/c.jsonl", Status: "submitted"},
	}
	kept, dropped := dropSubmittedUnlessForce(items, false)
	if dropped != 2 {
		t.Fatalf("expected 2 dropped, got %d", dropped)
	}
	if len(kept) != 1 || kept[0].Path != "/b.jsonl" {
		t.Fatalf("expected only /b.jsonl to survive, got %+v", kept)
	}
}

func TestDropSubmittedUnlessForceKeepsAllWhenForced(t *testing.T) {
	items := []conversation.Item{
		{Platform: conversation.PlatformCodex, Path: "/a.jsonl", Status: "submitted"},
		{Platform: conversation.PlatformCodex, Path: "/b.jsonl", Status: ""},
	}
	kept, dropped := dropSubmittedUnlessForce(items, true)
	if dropped != 0 {
		t.Fatalf("--force must drop nothing, got dropped=%d", dropped)
	}
	if len(kept) != 2 {
		t.Fatalf("--force must keep all items, got %+v", kept)
	}
}

// ---------------------------------------------------------------------------
// summarizeScanItems / buildScanView / render
// ---------------------------------------------------------------------------

func TestSummarizeScanItemsCountsByStatus(t *testing.T) {
	items := []conversation.Item{
		{Status: ""},
		{Status: "ready"},
		{Status: "submitted"},
		{Status: "submitted"},
		{Status: "unsupported"},
	}
	s := summarizeScanItems(items)
	if s.New != 2 {
		t.Errorf("expected 2 new (empty + ready), got %d", s.New)
	}
	if s.AlreadySubmitted != 2 {
		t.Errorf("expected 2 alreadySubmitted, got %d", s.AlreadySubmitted)
	}
	if s.Unsupported != 1 {
		t.Errorf("expected 1 unsupported, got %d", s.Unsupported)
	}
}

func TestBuildScanViewIncludesSummary(t *testing.T) {
	rep := &conversation.ScanReport{}
	items := []conversation.Item{
		{Platform: conversation.PlatformCodex, Path: "/a.jsonl", Status: "submitted"},
		{Platform: conversation.PlatformCodex, Path: "/b.jsonl", Status: ""},
	}
	view := buildScanView(rep, items)
	if view.Summary.New != 1 || view.Summary.AlreadySubmitted != 1 {
		t.Fatalf("expected summary {new:1, alreadySubmitted:1}, got %+v", view.Summary)
	}
}

// The grouped TOTAL line must append the new/imported counts additively —
// existing content (groups/sessions/messages) must remain intact.
func TestRenderScanGroupTableAppendsNewImportedCounts(t *testing.T) {
	v := scanView{
		Items: []scanItemView{
			{Platform: "codex", Path: "/a.jsonl", Messages: 3, Status: ""},
			{Platform: "codex", Path: "/b.jsonl", Messages: 4, Status: "submitted"},
		},
		Groups: []scanGroupView{
			{Platform: "codex", Area: "(all sessions)", Sessions: 2, Messages: 7},
		},
		Summary: scanSummaryView{New: 1, AlreadySubmitted: 1},
	}
	out := renderConversationScan(v, false)
	if !strings.Contains(out, "TOTAL:") {
		t.Fatalf("must still show TOTAL line:\n%s", out)
	}
	if !strings.Contains(out, "1 new") || !strings.Contains(out, "1 imported") {
		t.Fatalf("TOTAL line must append new/imported counts:\n%s", out)
	}
}

// ---------------------------------------------------------------------------
// Full pipeline integration: run --dry-run drops previously-submitted
// sessions before --limit selection and prints one stderr summary line.
// ---------------------------------------------------------------------------

func TestRunDryRunDropsSubmittedBeforeLimit(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "config"))
	dataDir := filepath.Join(home, "data")
	t.Setenv("XDG_DATA_HOME", dataDir)
	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, "cache"))

	// Two codex session files in a scan root: one will be pre-marked
	// submitted in state, the other left new. Distinct timestamps make
	// newest-first ordering deterministic.
	root := t.TempDir()
	oldContent := `{"timestamp":1749001000000,"type":"session_meta","payload":{}}
{"timestamp":1749001001000,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello old"}]}}
`
	newContent := `{"timestamp":1759001000000,"type":"session_meta","payload":{}}
{"timestamp":1759001001000,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello new"}]}}
`
	oldPath := filepath.Join(root, "old_session.jsonl")
	newPath := filepath.Join(root, "new_session.jsonl")
	if err := os.WriteFile(oldPath, []byte(oldContent), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(newPath, []byte(newContent), 0o644); err != nil {
		t.Fatal(err)
	}
	// Backdate both files past the active-session window so neither is
	// excluded as "still being written".
	old := time.Now().Add(-1 * time.Hour)
	os.Chtimes(oldPath, old, old)
	os.Chtimes(newPath, old, old)

	cmd := newConversationsRun()
	var out, errOut bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&errOut)
	cmd.SetArgs([]string{
		"codex",
		"--path", "codex=" + root,
		"--no-prompt",
		"--dry-run",
		"--detail",
		"--limit", "1",
	})

	// First dry-run with no state seeded: discover both sessions are "new"
	// and confirm the command runs end-to-end (also exercises the annotation
	// no-op path when the state file does not exist yet).
	if err := cmd.Execute(); err != nil {
		t.Fatalf("dry-run must not error: %v (stderr=%s)", err, errOut.String())
	}
	if !strings.Contains(out.String(), "new_session.jsonl") {
		t.Fatalf("with no state seeded, --limit 1 must pick the newest session, got:\n%s", out.String())
	}

	// Now seed state marking the NEW session as already submitted, and
	// re-run: --limit 1 must fall through to the OLD session instead of
	// wasting the budget on (and then dropping) the submitted one.
	statePath := filepath.Join(dataDir, "evercli", "conversations_import_state.json")
	st, err := conversation.LoadState(statePath, seedStateScope(t))
	if err != nil {
		t.Fatal(err)
	}
	st.MarkSubmitted(conversation.ItemStateKey(conversation.Item{Platform: conversation.PlatformCodex, Path: newPath}), "cid-new")
	if err := st.Save(); err != nil {
		t.Fatal(err)
	}

	cmd2 := newConversationsRun()
	var out2, errOut2 bytes.Buffer
	cmd2.SetOut(&out2)
	cmd2.SetErr(&errOut2)
	cmd2.SetArgs([]string{
		"codex",
		"--path", "codex=" + root,
		"--no-prompt",
		"--dry-run",
		"--detail",
		"--limit", "1",
	})
	if err := cmd2.Execute(); err != nil {
		t.Fatalf("second dry-run must not error: %v (stderr=%s)", err, errOut2.String())
	}
	if strings.Contains(out2.String(), "new_session.jsonl") {
		t.Fatalf("submitted session must be dropped pre-limit, not shown:\n%s", out2.String())
	}
	if !strings.Contains(out2.String(), "old_session.jsonl") {
		t.Fatalf("--limit 1 must fall through to the next (old) session once the submitted one is dropped:\n%s", out2.String())
	}
	if !strings.Contains(errOut2.String(), "skipped 1 previously imported session(s); pass --force to re-upload") {
		t.Fatalf("must print the one-line stderr summary, got: %s", errOut2.String())
	}
}

// ---------------------------------------------------------------------------
// Review finding fix: --exclude of an already-submitted session must not
// print a false "matched no session" warning. dropSubmittedUnlessForce used
// to run before applyExcludePaths, so a submitted session was already gone
// from the candidate set by the time --exclude tried to match it — a real
// match on a session scan actually discovered was misreported as
// "matched no session". applyExcludePaths must now resolve against the
// full since-filtered (pre-drop) set.
// ---------------------------------------------------------------------------

func TestRunExcludeSubmittedSessionNoFalseUnmatchedWarning(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "config"))
	dataDir := filepath.Join(home, "data")
	t.Setenv("XDG_DATA_HOME", dataDir)
	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, "cache"))

	root := t.TempDir()
	content := `{"timestamp":1749001000000,"type":"session_meta","payload":{}}
{"timestamp":1749001001000,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello submitted"}]}}
`
	sessPath := filepath.Join(root, "submitted_session.jsonl")
	if err := os.WriteFile(sessPath, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-1 * time.Hour)
	os.Chtimes(sessPath, old, old)

	// Mark this session submitted BEFORE the run, exactly like a prior
	// successful import would have.
	statePath := filepath.Join(dataDir, "evercli", "conversations_import_state.json")
	st, err := conversation.LoadState(statePath, seedStateScope(t))
	if err != nil {
		t.Fatal(err)
	}
	st.MarkSubmitted(conversation.ItemStateKey(conversation.Item{Platform: conversation.PlatformCodex, Path: sessPath}), "cid-submitted")
	if err := st.Save(); err != nil {
		t.Fatal(err)
	}

	runExcludeCase := func(t *testing.T, extraArgs ...string) (stdout, stderr string) {
		t.Helper()
		cmd := newConversationsRun()
		var out, errOut bytes.Buffer
		cmd.SetOut(&out)
		cmd.SetErr(&errOut)
		args := []string{
			"codex",
			"--path", "codex=" + root,
			"--no-prompt",
			"--dry-run",
			"--detail",
			"--exclude", sessPath,
		}
		args = append(args, extraArgs...)
		cmd.SetArgs(args)
		if err := cmd.Execute(); err != nil {
			t.Fatalf("dry-run must not error: %v (stderr=%s)", err, errOut.String())
		}
		return out.String(), errOut.String()
	}

	// Without --force: the session is both submitted AND explicitly
	// excluded. It must not upload, must not print the false "matched no
	// session" warning, and the exclusion itself should be acknowledged.
	out, errOut := runExcludeCase(t)
	if strings.Contains(errOut, "matched no session") {
		t.Fatalf("excluding an already-submitted session must not report a false unmatched warning, got stderr:\n%s", errOut)
	}
	if strings.Contains(out, "submitted_session.jsonl") {
		t.Fatalf("excluded session must not appear in the preview/upload set:\n%s", out)
	}
	if !strings.Contains(errOut, "excluded by --exclude: "+sessPath) {
		t.Fatalf("exclusion must be acknowledged on stderr, got:\n%s", errOut)
	}

	// With --force: force disables the submitted-drop, but --exclude must
	// still remove the path unconditionally — it must never upload/appear,
	// and still no false unmatched warning.
	outForce, errOutForce := runExcludeCase(t, "--force")
	if strings.Contains(errOutForce, "matched no session") {
		t.Fatalf("--force + --exclude on a submitted session must not report a false unmatched warning, got stderr:\n%s", errOutForce)
	}
	if strings.Contains(outForce, "submitted_session.jsonl") {
		t.Fatalf("--force must not resurrect an explicitly excluded session:\n%s", outForce)
	}
	if !strings.Contains(errOutForce, "excluded by --exclude: "+sessPath) {
		t.Fatalf("exclusion must be acknowledged on stderr even with --force, got:\n%s", errOutForce)
	}
	// --force must not print the "skipped ... previously imported" summary
	// for this session either — it was excluded, not drop-skipped.
	if strings.Contains(errOutForce, "previously imported session(s)") {
		t.Fatalf("with --force, the excluded session must not be counted as a submitted-drop, got:\n%s", errOutForce)
	}
}

// seedStateScope returns the ledger scope a run in this test environment
// will use, so a test can seed the state file the same way a real prior
// import would have. Deriving it (rather than hardcoding the default api
// base) keeps the fixture honest if the default ever moves.
func seedStateScope(t *testing.T) string {
	t.Helper()
	cfg, err := core.LoadConfig("")
	if err != nil {
		t.Fatal(err)
	}
	return conversation.StateScope(cfg.APIBaseURL, "")
}
