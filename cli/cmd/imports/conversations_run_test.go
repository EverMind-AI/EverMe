package imports

import (
	"testing"

	"evercli/internal/importer/conversation"
	"evercli/internal/output"
)

func TestApplyExcludePathsDropsMatchingPaths(t *testing.T) {
	items := []conversation.Item{
		{Platform: conversation.PlatformClaudeCode, Path: "/a/keep.jsonl"},
		{Platform: conversation.PlatformCodex, Path: "/b/drop.jsonl"},
		{Platform: conversation.PlatformHermes, Path: "/c/keep2.json"},
	}
	kept, excluded, unmatched, _ := applyExcludePaths(items, []string{"/b/drop.jsonl"})
	if len(kept) != 2 {
		t.Fatalf("expected 2 kept, got %d: %+v", len(kept), kept)
	}
	for _, it := range kept {
		if it.Path == "/b/drop.jsonl" {
			t.Fatalf("excluded path must not survive: %s", it.Path)
		}
	}
	if len(excluded) != 1 || excluded[0] != "/b/drop.jsonl" {
		t.Fatalf("expected excluded=[/b/drop.jsonl], got %v", excluded)
	}
	if len(unmatched) != 0 {
		t.Fatalf("expected no unmatched, got %v", unmatched)
	}
}

// A bare filename (as a human copies from the scan preview, which abbreviates
// long paths to "...suffix") must still match the full session path by
// basename — the original exact-only match silently dropped these, which is
// the TC-IMPORT-017 failure (no "excluded by" line was ever printed).
func TestApplyExcludePathsMatchesByBasename(t *testing.T) {
	items := []conversation.Item{
		{Platform: conversation.PlatformClaudeCode, Path: "/very/long/dir/abc-123.jsonl"},
		{Platform: conversation.PlatformClaudeCode, Path: "/very/long/dir/keep.jsonl"},
	}
	kept, excluded, unmatched, _ := applyExcludePaths(items, []string{"abc-123.jsonl"})
	if len(kept) != 1 || kept[0].Path != "/very/long/dir/keep.jsonl" {
		t.Fatalf("basename exclude should drop abc-123.jsonl, kept=%+v", kept)
	}
	if len(excluded) != 1 || excluded[0] != "/very/long/dir/abc-123.jsonl" {
		t.Fatalf("excluded must report the full path, got %v", excluded)
	}
	if len(unmatched) != 0 {
		t.Fatalf("expected no unmatched, got %v", unmatched)
	}
}

// Kimicode session transcripts are all named "wire.jsonl" (identity lives in
// the session_<uuid> directory, not the filename), so basename matching would
// collide across every session. Excluding ONE session by its full path must
// drop only that session; the OR match on filepath.Base used to make every
// wire.jsonl match and dropped all kimicode sessions ("No sessions found").
func TestApplyExcludePathsBasenameCollisionKeepsOthers(t *testing.T) {
	items := []conversation.Item{
		{Platform: conversation.PlatformKimicode, Path: "/h/.kimi-code/sessions/wd_p/session_AAAA/agents/main/wire.jsonl"},
		{Platform: conversation.PlatformKimicode, Path: "/h/.kimi-code/sessions/wd_p/session_BBBB/agents/main/wire.jsonl"},
		{Platform: conversation.PlatformKimicode, Path: "/h/.kimi-code/sessions/wd_p/session_CCCC/agents/main/wire.jsonl"},
	}
	target := items[0].Path
	kept, excluded, unmatched, _ := applyExcludePaths(items, []string{target})
	if len(kept) != 2 {
		t.Fatalf("excluding one wire.jsonl by full path must keep the other 2, got %d kept: %+v", len(kept), kept)
	}
	for _, it := range kept {
		if it.Path == target {
			t.Fatalf("excluded target must not survive: %s", it.Path)
		}
	}
	if len(excluded) != 1 || excluded[0] != target {
		t.Fatalf("expected excluded=[target], got %v", excluded)
	}
	if len(unmatched) != 0 {
		t.Fatalf("expected no unmatched, got %v", unmatched)
	}
}

// An --exclude value that matches nothing must be surfaced (fail-loud), not
// silently ignored.
func TestApplyExcludePathsReportsUnmatched(t *testing.T) {
	items := []conversation.Item{
		{Platform: conversation.PlatformClaudeCode, Path: "/a/keep.jsonl"},
	}
	kept, excluded, unmatched, _ := applyExcludePaths(items, []string{"/nope.jsonl", "keep.jsonl"})
	if len(kept) != 0 {
		t.Fatalf("keep.jsonl matches by basename, expected 0 kept, got %+v", kept)
	}
	if len(excluded) != 1 || excluded[0] != "/a/keep.jsonl" {
		t.Fatalf("expected excluded=[/a/keep.jsonl], got %v", excluded)
	}
	if len(unmatched) != 1 || unmatched[0] != "/nope.jsonl" {
		t.Fatalf("expected unmatched=[/nope.jsonl], got %v", unmatched)
	}
}

// A bare basename that collides across sessions (e.g. "wire.jsonl") must NOT
// drop anything and must be surfaced as ambiguous (guiding the user to pass the
// full session path), distinct from a value that matched nothing at all.
func TestApplyExcludePathsAmbiguousBasenameReported(t *testing.T) {
	items := []conversation.Item{
		{Platform: conversation.PlatformKimicode, Path: "/h/sessions/wd_p/session_AAAA/agents/main/wire.jsonl"},
		{Platform: conversation.PlatformKimicode, Path: "/h/sessions/wd_p/session_BBBB/agents/main/wire.jsonl"},
	}
	kept, excluded, unmatched, ambiguous := applyExcludePaths(items, []string{"wire.jsonl"})
	if len(kept) != 2 {
		t.Fatalf("ambiguous basename must drop nothing, got %d kept", len(kept))
	}
	if len(excluded) != 0 {
		t.Fatalf("expected no excluded, got %v", excluded)
	}
	if len(unmatched) != 0 {
		t.Fatalf("ambiguous is not the same as unmatched, got unmatched=%v", unmatched)
	}
	if len(ambiguous) != 1 || ambiguous[0] != "wire.jsonl" {
		t.Fatalf("expected ambiguous=[wire.jsonl], got %v", ambiguous)
	}
}

// --no-prompt must skip the interactive confirmation even in a TTY. The
// screenshot showed `run ... --no-prompt` still printing "Confirm import?".
func TestNeedsConfirm(t *testing.T) {
	if !needsConfirm(true, false) {
		t.Fatal("interactive TTY without --no-prompt must confirm")
	}
	if needsConfirm(true, true) {
		t.Fatal("--no-prompt in a TTY must skip confirmation")
	}
	if needsConfirm(false, true) || needsConfirm(false, false) {
		t.Fatal("non-interactive never prompts (guard already gated it)")
	}
}

// A run where some sessions failed must exit non-zero, not 0.
func TestRunExitError(t *testing.T) {
	if err := runExitError(0, 5); err != nil {
		t.Fatalf("no failures must yield nil, got %v", err)
	}
	if err := runExitError(2, 5); err == nil {
		t.Fatal("failures must yield a non-nil (non-zero exit) error")
	}
}

func TestRunRefusesNonInteractiveWithoutScope(t *testing.T) {
	err := runConversationsGuard(runGuardInput{IsTTY: false, NoPrompt: false, Platforms: nil})
	if err == nil {
		t.Fatal("non-interactive without explicit scope must be refused")
	}
	assertGuardErrIsInvalidArgs(t, err)
}

func TestRunNoPromptNeedsExplicitPlatform(t *testing.T) {
	err := runConversationsGuard(runGuardInput{IsTTY: false, NoPrompt: true, Platforms: nil})
	if err == nil {
		t.Fatal("--no-prompt still needs explicit platform/scope")
	}
	assertGuardErrIsInvalidArgs(t, err)

	if err := runConversationsGuard(runGuardInput{IsTTY: false, NoPrompt: true, Platforms: []string{"claude-code"}}); err != nil {
		t.Fatalf("explicit scope under --no-prompt should pass guard: %v", err)
	}
}

// assertGuardErrIsInvalidArgs pins the ABI-visible taxonomy for guard
// refusals: these are bad-input errors (exit code 2), not TypeInternal.
// A bare fmt.Errorf classifies as TypeInternal and mismaps to exit 1 with
// a misleading "internal" error.type in the envelope — the ECA E2E finding
// this fix addresses.
func assertGuardErrIsInvalidArgs(t *testing.T, err error) {
	t.Helper()
	ce, ok := output.AsCLIError(err)
	if !ok {
		t.Fatalf("guard error must be a *output.CLIError, got %T: %v", err, err)
	}
	if ce.Type != output.TypeInvalidArgs {
		t.Fatalf("guard error Type = %q, want %q (validation, exit code 2)", ce.Type, output.TypeInvalidArgs)
	}
}

// --dry-run uploads nothing; the guard exists to stop unattended bulk
// UPLOADS in CI, not previews. A non-interactive dry-run with no
// --no-prompt/--platform must be let through.
func TestRunDryRunBypassesGuardEvenWithoutScope(t *testing.T) {
	err := runConversationsGuard(runGuardInput{IsTTY: false, NoPrompt: false, Platforms: nil, DryRun: true})
	if err != nil {
		t.Fatalf("dry-run must bypass the guard, got %v", err)
	}
}

func TestRunDryRunBypassesGuardEvenWithNoPromptNoScope(t *testing.T) {
	err := runConversationsGuard(runGuardInput{IsTTY: false, NoPrompt: true, Platforms: nil, DryRun: true})
	if err != nil {
		t.Fatalf("dry-run must bypass the guard regardless of --no-prompt/platform state, got %v", err)
	}
}

// TestPlanForSubmitted covers the 2026-08-17 review item 1.2.3, second
// half: the only way to re-import a session the ledger already knows
// about was to know that --force exists. An interactive run should ask
// instead. Non-interactive runs must NOT gain a prompt - AI agents drive
// that path and would hang on it.
func TestPlanForSubmitted(t *testing.T) {
	cases := []struct {
		name             string
		alreadySubmitted int
		force            bool
		isTTY            bool
		noPrompt         bool
		want             submittedPlan
	}{
		{"nothing submitted, nothing to decide", 0, false, true, false, submittedSkip},
		{"force still means re-upload everything", 3, true, false, true, submittedReimport},
		{"interactive run asks", 3, false, true, false, submittedAsk},
		{"--no-prompt keeps skipping silently", 3, false, true, true, submittedSkip},
		{"non-tty keeps skipping silently", 3, false, false, false, submittedSkip},
	}
	for _, tc := range cases {
		got := planForSubmitted(tc.alreadySubmitted, tc.force, tc.isTTY, tc.noPrompt)
		if got != tc.want {
			t.Fatalf("%s: planForSubmitted(%d,%v,%v,%v) = %v, want %v",
				tc.name, tc.alreadySubmitted, tc.force, tc.isTTY, tc.noPrompt, got, tc.want)
		}
	}
}

// TestCountSubmitted pins the input planForSubmitted works from.
func TestCountSubmitted(t *testing.T) {
	items := []conversation.Item{
		{Status: "submitted"},
		{Status: "ready"},
		{Status: "submitted"},
		{Status: "unsupported"},
	}
	if got := countSubmitted(items); got != 2 {
		t.Fatalf("countSubmitted = %d, want 2", got)
	}
}
