package importer

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func writeMD(t *testing.T, root, rel, body string) {
	t.Helper()
	full := filepath.Join(root, rel)
	require.NoError(t, os.MkdirAll(filepath.Dir(full), 0o700))
	require.NoError(t, os.WriteFile(full, []byte(body), 0o600))
}

func TestScanMarkdownTree_HappyPath(t *testing.T) {
	root := t.TempDir()
	writeMD(t, root, "a.md", "# a")
	writeMD(t, root, "sub/b.md", "# b")
	writeMD(t, root, "ignored.txt", "skip me")

	scan, err := scanMarkdownTree(context.Background(), PlatformClaudeCode, root, nil)
	require.NoError(t, err)
	require.NotNil(t, scan)

	assert.Equal(t, 2, len(scan.Files))
	// Stable order: a.md before sub/b.md regardless of FS walk order.
	assert.Equal(t, "a.md", filepath.ToSlash(scan.Files[0].RelPath))
	assert.Equal(t, "sub/b.md", filepath.ToSlash(scan.Files[1].RelPath))
}

func TestScanMarkdownTree_SkipsBlacklistedAndOversize(t *testing.T) {
	root := t.TempDir()
	writeMD(t, root, "vendor/notes.md", "skipped")
	writeMD(t, root, ".git/notes.md", "skipped")
	writeMD(t, root, "node_modules/notes.md", "skipped")
	writeMD(t, root, "kept.md", "kept")
	// Oversize file
	big := strings.Repeat("x", int(SingleFileLimitBytes+1))
	writeMD(t, root, "big.md", big)

	scan, err := scanMarkdownTree(context.Background(), PlatformClaudeCode, root, nil)
	require.NoError(t, err)
	require.NotNil(t, scan)

	var kept []string
	for _, f := range scan.Files {
		kept = append(kept, filepath.Base(f.Path))
	}
	assert.Contains(t, kept, "kept.md")
	assert.NotContains(t, kept, "notes.md")
	assert.NotContains(t, kept, "big.md")

	// big.md must surface in skipped with the right reason.
	var skipReasons []string
	for _, sk := range scan.SkippedFiles {
		skipReasons = append(skipReasons, sk.Reason)
	}
	assert.Contains(t, strings.Join(skipReasons, "|"), "too large")
}

func TestScanMarkdownTree_SymlinkRootRejected(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks require admin on Windows; behavior intent is the same")
	}
	target := t.TempDir()
	writeMD(t, target, "a.md", "secret")

	holder := t.TempDir()
	link := filepath.Join(holder, "scan-root")
	require.NoError(t, os.Symlink(target, link))

	_, err := scanMarkdownTree(context.Background(), PlatformClaudeCode, link, nil)
	require.Error(t, err, "scan root must reject symlinks (closes the ~/.claude/projects → /etc escape)")
	assert.Contains(t, err.Error(), "symlink")
}

func TestScanMarkdownTree_RecordsFileSymlinkSkip(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks require admin on Windows")
	}
	root := t.TempDir()
	target := t.TempDir()
	writeMD(t, target, "real.md", "real content")
	link := filepath.Join(root, "linked.md")
	require.NoError(t, os.Symlink(filepath.Join(target, "real.md"), link))

	scan, err := scanMarkdownTree(context.Background(), PlatformClaudeCode, root, nil)
	require.NoError(t, err)
	assert.Empty(t, scan.Files, "symlink files must NOT be followed")

	// Skip entry must be visible so users know "why is linked.md missing".
	var reasons []string
	for _, sk := range scan.SkippedFiles {
		reasons = append(reasons, sk.Reason)
	}
	assert.Contains(t, strings.Join(reasons, "|"), "symlink")
}

func TestScanMarkdownTree_RejectsControlCharsInPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows file names can't contain newlines, so the gate is a no-op")
	}
	root := t.TempDir()
	// macOS / Linux allow \n in file names. Build one explicitly.
	bad := filepath.Join(root, "weird\nname.md")
	require.NoError(t, os.WriteFile(bad, []byte("x"), 0o600))
	good := filepath.Join(root, "sane.md")
	require.NoError(t, os.WriteFile(good, []byte("x"), 0o600))

	scan, err := scanMarkdownTree(context.Background(), PlatformClaudeCode, root, nil)
	require.NoError(t, err)
	assert.Equal(t, 1, len(scan.Files), "the \\n-bearing file must be skipped, not silently merged")
	assert.Equal(t, "sane.md", scan.Files[0].RelPath)
}

// TestOpenclawScanner_PicksUpWorkspaceRootMarkdown is the regression
// test for feedback §3.1: persona / identity files (USER.md,
// IDENTITY.md, SOUL.md, BOOTSTRAP.md, plus user-written notes) sit at
// workspace/ root, not inside workspace/memory/. The old scanner
// rooted at workspace/memory/ silently missed all of them — so users
// reported "I told it I like durian, but recall can't find it",
// because the source-of-truth file (workspace/USER.md) was never
// uploaded in the first place.
//
// This test asserts that under a workspace layout matching the real
// install:
//   - depth-1 *.md at workspace/ ARE included
//   - workspace/memory/ tree IS still scanned recursively
//   - other workspace subdirectories (skills/, agent project dirs)
//     are NOT recursed into — their content is runtime state, not
//     cold-start knowledge
//   - RelPaths are anchored at workspace/ so memory tree files come
//     out as "memory/<name>.md" and never collide with a root-level
//     file of the same basename.
func TestOpenclawScanner_PicksUpWorkspaceRootMarkdown(t *testing.T) {
	tmp := t.TempDir()
	workspace := filepath.Join(tmp, "workspace")
	require.NoError(t, os.MkdirAll(workspace, 0o700))

	// Workspace-root persona / identity files (feedback §3.1).
	writeMD(t, workspace, "USER.md", "user is alice; favorite color: blue")
	writeMD(t, workspace, "IDENTITY.md", "agent persona")
	writeMD(t, workspace, "SOUL.md", "values")
	writeMD(t, workspace, "BOOTSTRAP.md", "boot config")
	writeMD(t, workspace, "project-notes.md", "user-written notes at workspace root")

	// memory/ subtree (legacy scan target, must still be picked up).
	writeMD(t, workspace, "memory/2026-05-13.md", "today's notes")
	writeMD(t, workspace, "memory/sub/older.md", "older notes")

	// A non-memory subdir whose content should NOT be swept in —
	// agent skill workspace.
	writeMD(t, workspace, "skills/some-skill/README.md", "do not include")
	// And a subdir matching a name a memory-tree file might have,
	// to prove RelPath anchoring keeps them distinct.
	writeMD(t, workspace, "memory/USER.md", "memory-tree USER (distinct from root USER.md)")

	t.Setenv("OPENCLAW_CONFIG_DIR", tmp)
	scan, err := newOpenclawScanner().Scan(context.Background(), nil)
	require.NoError(t, err)
	require.NotNil(t, scan)
	assert.Equal(t, workspace, scan.RootPath,
		"RootPath should be the workspace, not workspace/memory")

	got := map[string]bool{}
	for _, f := range scan.Files {
		got[filepath.ToSlash(f.RelPath)] = true
	}

	// Workspace-root persona files: present.
	for _, name := range []string{"USER.md", "IDENTITY.md", "SOUL.md", "BOOTSTRAP.md", "project-notes.md"} {
		assert.True(t, got[name], "workspace-root file %q should be in the scan", name)
	}
	// memory/ tree files: present, with the memory/ prefix proving the
	// RelPath anchor is workspace, not memory.
	assert.True(t, got["memory/2026-05-13.md"], "memory tree top file should be present")
	assert.True(t, got["memory/sub/older.md"], "memory tree nested file should be present")
	assert.True(t, got["memory/USER.md"],
		"memory/USER.md must coexist with root USER.md — different RelPaths")

	// Subdirs other than memory/ at workspace level: NOT recursed.
	assert.False(t, got["skills/some-skill/README.md"],
		"non-memory subdir content must not be swept in by the depth-1 workspace pass")

	// Sanity: total counts add up. 5 root files + 3 memory-tree files = 8.
	assert.Equal(t, 8, len(scan.Files),
		"expected 5 workspace-root + 3 memory-tree files; got %d", len(scan.Files))
}

// TestOpenclawScanner_MissingWorkspaceIsNotAnError covers a fresh
// install where ~/.openclaw/workspace/ doesn't exist yet. The legacy
// behavior (treat missing root as empty scan) must survive the
// refactor — users shouldn't see a hard error from a clean machine.
func TestOpenclawScanner_MissingWorkspaceIsNotAnError(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("OPENCLAW_CONFIG_DIR", tmp)
	// No workspace/ dir created.
	scan, err := newOpenclawScanner().Scan(context.Background(), nil)
	require.NoError(t, err)
	require.NotNil(t, scan)
	assert.Empty(t, scan.Files)
	assert.Empty(t, scan.SkippedFiles)
}

// TestClaudeCodeScanner_PicksUpRootCLAUDEmd is the §3.1-analog
// regression for claude-code: the old scanner rooted at
// ~/.claude/projects/ silently missed ~/.claude/CLAUDE.md, the
// user-level global memory file Anthropic documents as the
// per-user personalization slot. After this fix, depth-1 *.md at
// ~/.claude/ is picked up, while projects/ is still recursed.
func TestClaudeCodeScanner_PicksUpRootCLAUDEmd(t *testing.T) {
	tmp := t.TempDir()

	// Root-level user memory (the file the old scanner missed).
	writeMD(t, tmp, "CLAUDE.md", "user is alice; loves hiking")
	writeMD(t, tmp, "notes.md", "free-form notes the user dropped here")

	// projects/ tree (legacy scan target, must still be picked up).
	writeMD(t, tmp, "projects/-Users-admin-code-foo/memory/x.md", "project foo memory")
	writeMD(t, tmp, "projects/-Users-admin-code-bar/y.md", "bar transcript-adjacent note")

	// Subdirs at ~/.claude/ that hold runtime state — must NOT be
	// swept in by the depth-1 pass.
	writeMD(t, tmp, "sessions/some-session/state.md", "do not include")
	writeMD(t, tmp, "plans/some-plan.md", "do not include")
	writeMD(t, tmp, "file-history/x.md", "do not include")

	t.Setenv("CLAUDE_CONFIG_DIR", tmp)
	scan, err := newClaudeCodeScanner().Scan(context.Background(), nil)
	require.NoError(t, err)
	require.NotNil(t, scan)
	assert.Equal(t, tmp, scan.RootPath,
		"RootPath should be the config dir, not config/projects")

	got := map[string]bool{}
	for _, f := range scan.Files {
		got[filepath.ToSlash(f.RelPath)] = true
	}

	assert.True(t, got["CLAUDE.md"],
		"root-level CLAUDE.md is the whole point of this fix")
	assert.True(t, got["notes.md"],
		"any user-written *.md at ~/.claude/ root should come along too")
	assert.True(t, got["projects/-Users-admin-code-foo/memory/x.md"],
		"projects/ recursion preserved")
	assert.True(t, got["projects/-Users-admin-code-bar/y.md"],
		"projects/ recursion preserved (any depth)")

	assert.False(t, got["sessions/some-session/state.md"],
		"sessions/ holds runtime state — must not be in cold-start import")
	assert.False(t, got["plans/some-plan.md"],
		"plans/ is /plan-skill output — must not be swept by default")
	assert.False(t, got["file-history/x.md"],
		"file-history/ is snapshot state — must not be swept by default")

	// Sanity: 2 root + 2 projects = 4 expected.
	assert.Equal(t, 4, len(scan.Files),
		"expected 2 root + 2 projects files; got %d", len(scan.Files))
}

// TestClaudeCodeScanner_MissingConfigDirIsNotAnError covers a fresh
// install where ~/.claude/ doesn't exist yet — for example a user
// who just installed Claude Code but hasn't launched it. Importer
// must treat this as an empty scan, not a hard error.
func TestClaudeCodeScanner_MissingConfigDirIsNotAnError(t *testing.T) {
	tmp := t.TempDir()
	missing := filepath.Join(tmp, "no-such-claude-dir")
	t.Setenv("CLAUDE_CONFIG_DIR", missing)
	scan, err := newClaudeCodeScanner().Scan(context.Background(), nil)
	require.NoError(t, err)
	require.NotNil(t, scan)
	assert.Empty(t, scan.Files)
	assert.Empty(t, scan.SkippedFiles)
}
