package importer

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestMerge_V2FormatLocked asserts the on-disk shape produced by Merge.
// Backend SplitForIngest depends on this format byte-for-byte; if these
// assertions break we've changed the contract and must bump
// MergeFormatVersion before merging.
func TestMerge_V2FormatLocked(t *testing.T) {
	tmp := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(tmp, "a.md"), []byte("# A\n\nFirst body.\n"), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(tmp, "b.md"), []byte("# B\n\nSecond body."), 0o600))

	scan := &SourceScan{
		Platform: PlatformOpenClaw,
		RootPath: tmp,
		Files: []ScanFile{
			{Path: filepath.Join(tmp, "a.md"), RelPath: "a.md"},
			{Path: filepath.Join(tmp, "b.md"), RelPath: "b.md"},
		},
		TotalBytes: 30,
	}
	merged, err := Merge(scan, MergeOptions{
		Now: time.Date(2026, 4, 29, 12, 0, 0, 0, time.UTC),
	})
	require.NoError(t, err)
	body := string(merged.Body)

	// Front matter declares v2.
	assert.Contains(t, body, "everme_import_version: 2",
		"format version must be advertised in YAML front matter so the backend dispatcher can pick the right parser")

	// HTML-comment markers in place of `## relPath` headings.
	assert.Contains(t, body, `<!-- everme:file rel="a.md" -->`)
	assert.Contains(t, body, `<!-- everme:file rel="b.md" -->`)

	// The legacy v1 separators MUST be gone — backend v2 splitter does
	// not look for them.
	assert.NotContains(t, body, "## a.md", "v1 ## headings should not appear in v2 output")
	assert.NotContains(t, body, "\n---\n\n## ", "v1 separator-then-heading sequence must be gone")

	// Section content order matches input order.
	idxA := strings.Index(body, `rel="a.md"`)
	idxB := strings.Index(body, `rel="b.md"`)
	require.GreaterOrEqual(t, idxA, 0)
	require.GreaterOrEqual(t, idxB, 0)
	assert.Less(t, idxA, idxB, "files appear in scan order")

	// User-supplied content comes through unmodified (sans CRLF normalize).
	assert.Contains(t, body, "First body.")
	assert.Contains(t, body, "Second body.")
}

func TestMerge_V2_EscapesQuotesInRelPath(t *testing.T) {
	tmp := t.TempDir()
	rel := `weird "quoted" name.md`
	require.NoError(t, os.WriteFile(filepath.Join(tmp, "weird.md"), []byte("body"), 0o600))

	scan := &SourceScan{
		Platform: PlatformClaudeCode,
		Files: []ScanFile{
			{Path: filepath.Join(tmp, "weird.md"), RelPath: rel},
		},
	}
	merged, err := Merge(scan, MergeOptions{Now: time.Now().UTC()})
	require.NoError(t, err)

	// Quote in relPath must be backslash-escaped so the regex parser
	// on the backend still finds the closing `" -->`.
	assert.Contains(t, string(merged.Body), `rel="weird \"quoted\" name.md"`)
}
