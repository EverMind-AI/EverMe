package importer

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"evercli/internal/output"
)

// SingleFileLimitBytes is the per-file ceiling. Files past this are
// skipped (with SkipReason) rather than counted toward the merge.
const SingleFileLimitBytes = 1 << 20 // 1 MB

// blacklistDirs are pruned during scan walk. Lowercase comparison; users
// can extend via cmd flag (--exclude) which appends to this set.
//
// We bias toward over-pruning: false negatives ("you missed my notes
// in vendor/") are easier to recover from with --include than false
// positives ("import scan walked 200k generated files").
var blacklistDirs = map[string]struct{}{
	".git":          {},
	".hg":           {},
	".svn":          {},
	"node_modules":  {},
	".venv":         {},
	".env":          {},
	"__pycache__":   {},
	".tox":          {},
	".mypy_cache":   {},
	".pytest_cache": {},
	"dist":          {},
	"build":         {},
	"target":        {}, // Rust / Java
	"vendor":        {}, // Go vendor / Composer
	"coverage":      {},
	".next":         {},
	".nuxt":         {},
	".gradle":       {},
	".idea":         {},
	".vscode":       {},
}

// Scanner probes one platform's memory directory.
type Scanner interface {
	Platform() PlatformID
	Root() (string, error)
	Scan(ctx context.Context, extraExclude []string) (*SourceScan, error)
}

// ---- Claude Code ----------------------------------------------------

type claudeCodeScanner struct{}

func newClaudeCodeScanner() *claudeCodeScanner { return &claudeCodeScanner{} }

func (claudeCodeScanner) Platform() PlatformID { return PlatformClaudeCode }

// Root reports the Claude Code config directory the scanner anchors
// at. The actual scan covers two zones inside it:
//
//   - depth-1 *.md under ~/.claude/ — picks up the user-level
//     CLAUDE.md global memory file (Anthropic's documented per-user
//     personalization slot) and any other markdown notes the user
//     keeps next to it. Without this pass we never sweep the
//     persona / preferences content that lives at this layer.
//   - full recursion of ~/.claude/projects/ — per-project session
//     directories where transcripts and project memory live, same
//     as before.
//
// Other ~/.claude/ subdirectories (sessions/, plans/, file-history/,
// cache/, shell-snapshots/, …) are intentionally NOT descended into.
// They hold Claude Code runtime state, command history, and snapshot
// artifacts that don't belong in cold-start knowledge import; users
// who want them in scope should opt in via a future `--root` /
// `--include` flag.
func (claudeCodeScanner) Root() (string, error) {
	return claudeConfigRoot()
}

// claudeConfigRoot resolves the Claude Code config directory honoring
// $CLAUDE_CONFIG_DIR so tests / non-default installs work.
func claudeConfigRoot() (string, error) {
	if dir := os.Getenv("CLAUDE_CONFIG_DIR"); dir != "" {
		return dir, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude"), nil
}

func (s claudeCodeScanner) Scan(ctx context.Context, extraExclude []string) (*SourceScan, error) {
	configRoot, err := claudeConfigRoot()
	if err != nil {
		return nil, output.IOErr("home-dir", "resolve", err)
	}
	scan := &SourceScan{
		Platform: PlatformClaudeCode,
		Type:     "cold-start",
		RootPath: configRoot,
	}
	excluded := mergeExcludes(extraExclude)

	// Pass 1: top-level *.md at ~/.claude/ root — captures CLAUDE.md
	// and any siblings the user keeps there.
	if err := walkMarkdownAtDepth1(ctx, scan, configRoot, configRoot); err != nil {
		return nil, err
	}

	// Pass 2: ~/.claude/projects/ recursive. Relpath anchored at
	// configRoot so files come out as `projects/<encoded-path>/<file>.md`,
	// leaving any root-level `CLAUDE.md` etc. unambiguously identifiable
	// in the merged document.
	projectsRoot := filepath.Join(configRoot, "projects")
	if err := walkMarkdownTreeInto(ctx, scan, projectsRoot, configRoot, excluded); err != nil {
		return nil, err
	}

	sort.Slice(scan.Files, func(i, j int) bool {
		return filepath.ToSlash(scan.Files[i].RelPath) < filepath.ToSlash(scan.Files[j].RelPath)
	})
	return scan, nil
}

// ---- OpenClaw -------------------------------------------------------

type openclawScanner struct{}

func newOpenclawScanner() *openclawScanner { return &openclawScanner{} }

func (openclawScanner) Platform() PlatformID { return PlatformOpenClaw }

// Root reports the workspace directory the scanner anchors at. The
// actual scan covers two zones inside it:
//
//   - depth-1 *.md under workspace/ — picks up persona / identity
//     files (USER.md, IDENTITY.md, SOUL.md, BOOTSTRAP.md, AGENTS.md,
//     plus any user-written project notes that landed at workspace
//     root) that the old memory-only scan silently missed.
//   - full recursion of workspace/memory/ — the per-conversation
//     memory log, same as before.
//
// Subdirectories at workspace level other than memory/ (skills/,
// per-agent project workspaces, tmp/, …) are intentionally NOT
// descended into. They hold runtime state and per-skill scratch
// content that doesn't belong in cold-start knowledge import; users
// who want them in scope should opt in via a future `--root`/
// `--include` flag rather than have us silently sweep gigabytes of
// agent state into the cloud.
func (openclawScanner) Root() (string, error) {
	return openclawWorkspaceRoot()
}

// openclawWorkspaceRoot resolves the workspace directory honoring
// $OPENCLAW_CONFIG_DIR so tests / non-default installs work.
func openclawWorkspaceRoot() (string, error) {
	if dir := os.Getenv("OPENCLAW_CONFIG_DIR"); dir != "" {
		return filepath.Join(dir, "workspace"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".openclaw", "workspace"), nil
}

func (s openclawScanner) Scan(ctx context.Context, extraExclude []string) (*SourceScan, error) {
	workspaceRoot, err := openclawWorkspaceRoot()
	if err != nil {
		return nil, output.IOErr("home-dir", "resolve", err)
	}
	scan := &SourceScan{
		Platform: PlatformOpenClaw,
		Type:     "cold-start",
		RootPath: workspaceRoot,
	}
	excluded := mergeExcludes(extraExclude)

	// Pass 1: top-level *.md at workspace root. Tolerates missing
	// workspace dir (fresh install) — the next pass still tries
	// memory/ which has its own missing-root handling.
	if err := walkMarkdownAtDepth1(ctx, scan, workspaceRoot, workspaceRoot); err != nil {
		return nil, err
	}

	// Pass 2: workspace/memory/ recursive. Relpath anchored at
	// workspaceRoot so files come out as `memory/<name>.md`, leaving
	// `USER.md` etc. unambiguously identifiable in the merged document.
	memoryRoot := filepath.Join(workspaceRoot, "memory")
	if err := walkMarkdownTreeInto(ctx, scan, memoryRoot, workspaceRoot, excluded); err != nil {
		return nil, err
	}

	sort.Slice(scan.Files, func(i, j int) bool {
		return filepath.ToSlash(scan.Files[i].RelPath) < filepath.ToSlash(scan.Files[j].RelPath)
	})
	return scan, nil
}

// ---- shared walk ----------------------------------------------------

// scanMarkdownTree walks root recursively collecting *.md files.
// Behavior:
//   - missing root → SourceScan with FileCount=0 (not an error)
//   - blacklist dirs pruned
//   - files > SingleFileLimitBytes → SkippedFiles
//   - symlinks NOT followed (avoid loops, see 05-import.md §5.6)
//   - the root itself is rejected when it's a symlink so a malicious /
//     accidentally-misconfigured `~/.claude/projects → /etc` doesn't
//     leak unrelated host content into the merge.
//
// This is the simple single-root entry used by scanners that have one
// directory tree to walk (Claude Code). Scanners that need to combine
// several roots (OpenClaw: workspace top-level + workspace/memory/)
// build their own SourceScan and call walkMarkdownTreeInto /
// walkMarkdownAtDepth1 directly so RelPaths can share a single anchor.
func scanMarkdownTree(ctx context.Context, p PlatformID, root string, extraExclude []string) (*SourceScan, error) {
	scan := &SourceScan{Platform: p, Type: "cold-start", RootPath: root}
	excluded := mergeExcludes(extraExclude)
	if err := walkMarkdownTreeInto(ctx, scan, root, root, excluded); err != nil {
		return nil, err
	}
	// Stable order matters — merger output must hash-match across runs.
	sort.Slice(scan.Files, func(i, j int) bool {
		return filepath.ToSlash(scan.Files[i].RelPath) < filepath.ToSlash(scan.Files[j].RelPath)
	})
	return scan, nil
}

// walkMarkdownTreeInto performs the recursive *.md walk used by
// scanMarkdownTree, but appends to a caller-supplied SourceScan and
// computes RelPath against relPathBase rather than walkRoot.
//
// relPathBase is what lets a scanner combine multiple walks into one
// SourceScan without RelPath collisions: pass the same workspace root
// for every walk, and a file at `workspace/memory/x.md` comes out as
// `memory/x.md` while a sibling `workspace/USER.md` stays `USER.md`.
//
// Missing walkRoot is "no files", not an error (fresh installs).
func walkMarkdownTreeInto(ctx context.Context, scan *SourceScan, walkRoot, relPathBase string, excluded map[string]struct{}) error {
	// Lstat first so a symlink ROOT doesn't get followed silently.
	// os.Stat would happily resolve `~/.claude/projects → /etc` and
	// WalkDir would then walk /etc, which is exactly the symlink-
	// escape attack surface we want to close.
	linfo, err := os.Lstat(walkRoot)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return output.IOErr(walkRoot, "lstat-root", err)
	}
	if linfo.Mode()&os.ModeSymlink != 0 {
		return output.Invalid(
			fmt.Sprintf("scan root %s is a symlink; refusing to follow", walkRoot),
			"Replace the symlink with a real directory or point the platform at a non-symlinked path",
		)
	}
	info, err := os.Stat(walkRoot)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return output.IOErr(walkRoot, "stat-root", err)
	}
	if !info.IsDir() {
		return nil
	}

	// rootResolved is the canonicalized form of walkRoot we use to
	// verify every visited file actually lives under it. Cheap defense
	// against rare cases where filepath.WalkDir would otherwise hand
	// us a path that escaped via a parent-relative oddity. If
	// EvalSymlinks itself fails, record a SkipEntry so users see "the
	// safety net is not active" instead of the previous silent
	// fall-through.
	rootResolved, evalErr := filepath.EvalSymlinks(walkRoot)
	if evalErr != nil {
		scan.SkippedFiles = append(scan.SkippedFiles, SkipEntry{
			Path:   walkRoot,
			Reason: "EvalSymlinks failed; symlink-escape defense disabled: " + evalErr.Error(),
		})
	}

	walkErr := filepath.WalkDir(walkRoot, func(p string, d fs.DirEntry, err error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			scan.SkippedFiles = append(scan.SkippedFiles, SkipEntry{Path: p, Reason: "walk error: " + err.Error()})
			return nil
		}
		if d.IsDir() {
			if p == walkRoot {
				return nil
			}
			name := strings.ToLower(d.Name())
			if _, blocked := excluded[name]; blocked {
				return fs.SkipDir
			}
			if d.Type()&os.ModeSymlink != 0 {
				scan.SkippedFiles = append(scan.SkippedFiles, SkipEntry{Path: p, Reason: "directory symlink (not followed)"})
				return fs.SkipDir
			}
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			scan.SkippedFiles = append(scan.SkippedFiles, SkipEntry{Path: p, Reason: "file symlink (not followed)"})
			return nil
		}
		if !strings.HasSuffix(strings.ToLower(d.Name()), ".md") {
			return nil
		}
		// Defense in depth: if the resolved file path escapes the
		// resolved root we drop it.
		if rootResolved != "" {
			if resolved, err := filepath.EvalSymlinks(p); err == nil {
				if !strings.HasPrefix(resolved, rootResolved+string(filepath.Separator)) && resolved != rootResolved {
					scan.SkippedFiles = append(scan.SkippedFiles, SkipEntry{Path: p, Reason: "escaped scan root after resolve"})
					return nil
				}
			}
		}
		fi, err := d.Info()
		if err != nil {
			scan.SkippedFiles = append(scan.SkippedFiles, SkipEntry{Path: p, Reason: "stat error"})
			return nil
		}
		appendMarkdownFile(scan, p, relPathBase, fi)
		return nil
	})
	// A walk that ended because ctx was cancelled OR timed out must be
	// surfaced as cancellation (exit 130 / TypeCancelled), not as a
	// generic IO error (exit 5 / TypeIO). The previous check missed
	// DeadlineExceeded, so `--timeout`-driven cancellation during a
	// large scan was being mis-classified.
	if walkErr != nil {
		if errors.Is(walkErr, context.Canceled) || errors.Is(walkErr, context.DeadlineExceeded) {
			return walkErr
		}
		return output.IOErr(walkRoot, "walk", walkErr)
	}
	return nil
}

// walkMarkdownAtDepth1 reads dir's top-level *.md files (no recursion)
// and appends them to scan with RelPath anchored at relPathBase.
// Missing dir is treated as "no files" (fresh install before any
// workspace setup). Symlinked dir is rejected the same way the
// recursive walker rejects symlinked roots, so a symlinked
// $OPENCLAW_CONFIG_DIR pointing at /etc cannot leak files in.
//
// This is the depth-1 counterpart to walkMarkdownTreeInto: same
// per-file safety checks (size cap, control-char filter, file-symlink
// skip), no subdirectory descent.
func walkMarkdownAtDepth1(ctx context.Context, scan *SourceScan, dir, relPathBase string) error {
	linfo, err := os.Lstat(dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return output.IOErr(dir, "lstat-root", err)
	}
	if linfo.Mode()&os.ModeSymlink != 0 {
		return output.Invalid(
			fmt.Sprintf("scan root %s is a symlink; refusing to follow", dir),
			"Replace the symlink with a real directory or point the platform at a non-symlinked path",
		)
	}
	if !linfo.IsDir() {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return output.IOErr(dir, "readdir", err)
	}
	for _, e := range entries {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if e.IsDir() {
			continue
		}
		p := filepath.Join(dir, e.Name())
		if e.Type()&os.ModeSymlink != 0 {
			scan.SkippedFiles = append(scan.SkippedFiles, SkipEntry{Path: p, Reason: "file symlink (not followed)"})
			continue
		}
		if !strings.HasSuffix(strings.ToLower(e.Name()), ".md") {
			continue
		}
		fi, err := e.Info()
		if err != nil {
			scan.SkippedFiles = append(scan.SkippedFiles, SkipEntry{Path: p, Reason: "stat error"})
			continue
		}
		appendMarkdownFile(scan, p, relPathBase, fi)
	}
	return nil
}

// appendMarkdownFile applies the per-file size / control-char checks
// shared by walkMarkdownTreeInto and walkMarkdownAtDepth1, then
// records either a ScanFile or a SkipEntry.
//
// relPathBase is the anchor used when computing the file's RelPath —
// the merged document marker (`<!-- everme:file rel="..." -->`) keys
// off this value, so collisions across multiple walks are avoided by
// using a single shared anchor for them all.
func appendMarkdownFile(scan *SourceScan, fullPath, relPathBase string, fi fs.FileInfo) {
	if fi.Size() > SingleFileLimitBytes {
		scan.SkippedFiles = append(scan.SkippedFiles, SkipEntry{Path: fullPath, Reason: "file too large (>1MB)"})
		return
	}
	rel, _ := filepath.Rel(relPathBase, fullPath)
	// Reject files whose path contains \r or \n: they would corrupt
	// the merged-document marker and the backend reverse-splitter
	// can't reconstruct them. The scanner is the right gate because
	// we still know the original path; downstream merger only sees
	// RelPath.
	if strings.ContainsAny(rel, "\r\n") {
		scan.SkippedFiles = append(scan.SkippedFiles, SkipEntry{Path: fullPath, Reason: "file path contains control characters"})
		return
	}
	scan.Files = append(scan.Files, ScanFile{
		Path:       fullPath,
		RelPath:    rel,
		Title:      filepath.Base(fullPath),
		SizeBytes:  fi.Size(),
		ModifiedAt: fi.ModTime(),
	})
	scan.TotalBytes += fi.Size()
}

func mergeExcludes(extra []string) map[string]struct{} {
	out := make(map[string]struct{}, len(blacklistDirs)+len(extra))
	for k := range blacklistDirs {
		out[k] = struct{}{}
	}
	for _, e := range extra {
		out[strings.ToLower(strings.TrimSpace(e))] = struct{}{}
	}
	return out
}

// ScanRegistry returns the production scanner set, in stable order.
func ScanRegistry() []Scanner {
	return []Scanner{newClaudeCodeScanner(), newOpenclawScanner()}
}

// ToSummary collapses a SourceScan into the smaller form returned by
// `import scan` (no per-file rows, only sample titles).
func (s *SourceScan) ToSummary() ScanSummary {
	sum := ScanSummary{
		Platform:     s.Platform,
		Type:         s.Type,
		RootPath:     s.RootPath,
		FileCount:    len(s.Files),
		TotalBytes:   s.TotalBytes,
		SkippedCount: len(s.SkippedFiles),
	}
	for i, f := range s.Files {
		if i >= 5 {
			break
		}
		sum.SampleTitles = append(sum.SampleTitles, f.Title)
	}
	for i, sk := range s.SkippedFiles {
		if i >= 3 {
			break
		}
		sum.SkippedSamples = append(sum.SkippedSamples, sk)
	}
	return sum
}
