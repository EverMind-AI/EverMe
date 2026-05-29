package importer

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
	"time"

	"evercli/internal/output"
)

// MergeOptions controls per-merge knobs. SourceID populates the source
// field of the doc-key derivation and MUST be unique per (machine, user,
// platform) — otherwise two installs collide on the same documentKey and
// the backend's version chain treats unrelated installs as revisions.
// Callers pass machineid.Fingerprint(platform). Empty is allowed only in
// tests and falls back to "default_local".
type MergeOptions struct {
	AgentID  string // optional; embedded in front matter for diagnostics
	SourceID string // per-(machine,user,platform); empty → "default_local" (tests only)
	Now      time.Time
}

// MergeFormatVersion is the on-disk format the merger writes. The
// backend reverse-splitter dispatches on this value.
//
// v2: each file is delimited by an HTML-comment marker
// `<!-- everme:file rel="..." -->`. Markdown-invisible, free of
// collision with user content, easy to parse.
const MergeFormatVersion = 2

// fileMarkerFormat is the per-section sentinel. HTML comments are NOT
// rendered by any markdown viewer, so they don't disturb the document
// when read by humans, while being trivial to parse byte-for-byte.
//
// We escape `"` and `\` in the rel attribute value so paths containing
// those characters round-trip cleanly.
const fileMarkerFormat = `<!-- everme:file rel="%s" -->`

// MaxMergedTotalBytes caps the cumulative bytes the merger is willing
// to assemble. This is a separate ceiling from MaxMergedBytes (the
// uploader cap) because the merge step also has to hold every byte in
// RAM at once for the bytes.Buffer; even with a generous per-file
// limit (1 MiB), a directory with 10k files lands at ~10 GiB which
// would OOM the CLI process before the upload step even begins. 256 MiB
// is the same number we use for upload — anything past that should
// fail-fast at the scan boundary, not after we've already read every
// file.
const MaxMergedTotalBytes int64 = 256 << 20

// Merge produces a single MergedDoc from a SourceScan. Files are read in
// scan.Files order (which the scanner sorts by RelPath for stability).
//
// Output structure (v2):
//
//	---
//	everme_import_version: 2
//	platform: <platform>
//	agent_id: <optional>
//	merged_at: <RFC3339>
//	file_count: <N>
//	total_bytes: <sum of original sizes>
//	document_key_hint: cold_start_merge_<platform>
//	---
//
//	# Cold-start memory merged from <platform>
//
//	_This file is an automated merge of <N> local memory files._
//
//	<!-- everme:file rel="<relPath_1>" -->
//
//	[file 1 content, line endings normalized to \n]
//
//	<!-- everme:file rel="<relPath_2>" -->
//
//	[file 2 content]
//	...
//
// The backend `worker.SplitForIngest` reverses this format, producing
// one ContentChunk per original file with `Name=relPath` so EverOS
// retrieval can surface the source file in search results.
//
// DocumentKey is derived from (sourceKey, logicalPath) so reruns chain
// into the same backend version chain.
func Merge(scan *SourceScan, opts MergeOptions) (*MergedDoc, error) {
	if scan == nil || len(scan.Files) == 0 {
		return nil, output.Invalid("no files to merge", "Run `evercli import scan` to see what's available")
	}
	if scan.TotalBytes > MaxMergedTotalBytes {
		return nil, output.Invalid(
			fmt.Sprintf("scan total %d bytes exceeds local merge cap %d", scan.TotalBytes, MaxMergedTotalBytes),
			"Tighten --exclude or split the import into smaller batches",
		)
	}
	if opts.Now.IsZero() {
		opts.Now = time.Now().UTC()
	}

	sourceKey := opts.SourceID
	if sourceKey == "" {
		sourceKey = "default_local"
	}
	logicalPath := "cold_start_merge_" + string(scan.Platform)
	docKey := buildDocumentKey(sourceKey, logicalPath)

	var buf bytes.Buffer
	// Front matter (v2).
	fmt.Fprintf(&buf, "---\n")
	fmt.Fprintf(&buf, "everme_import_version: %d\n", MergeFormatVersion)
	fmt.Fprintf(&buf, "platform: %s\n", scan.Platform)
	if opts.AgentID != "" {
		fmt.Fprintf(&buf, "agent_id: %s\n", opts.AgentID)
	}
	fmt.Fprintf(&buf, "merged_at: %s\n", opts.Now.Format(time.RFC3339))
	fmt.Fprintf(&buf, "file_count: %d\n", len(scan.Files))
	fmt.Fprintf(&buf, "total_bytes: %d\n", scan.TotalBytes)
	fmt.Fprintf(&buf, "document_key_hint: %s\n", logicalPath)
	fmt.Fprintf(&buf, "---\n\n")
	fmt.Fprintf(&buf, "# Cold-start memory merged from %s\n\n", scan.Platform)
	fmt.Fprintf(&buf, "_This file is an automated merge of %d local memory files._\n\n",
		len(scan.Files))

	for _, f := range scan.Files {
		// HTML comment marker — markdown-invisible, can't collide with
		// user content. Backend SplitForIngest splits on these.
		fmt.Fprintf(&buf, fileMarkerFormat, escapeRelPath(f.RelPath))
		buf.WriteString("\n\n")

		raw, err := os.ReadFile(f.Path)
		if err != nil {
			return nil, output.IOErr(f.Path, "read", err)
		}
		// Normalize line endings — keeps hash stable across CRLF/LF
		// and makes downstream parsers (regex, scanners) predictable.
		clean := normalizeLineEndings(raw)
		buf.Write(clean)
		// Each section ends with exactly one trailing blank line so
		// the next marker sits on its own line. No more `---`
		// separator — section boundary IS the next marker.
		if !bytes.HasSuffix(clean, []byte("\n")) {
			buf.WriteByte('\n')
		}
		buf.WriteByte('\n')
	}

	body := buf.Bytes()
	hash := sha256.Sum256(body)

	fileName := fmt.Sprintf("cold-start-%s-%s.md", scan.Platform, opts.Now.Format("20060102-150405"))

	return &MergedDoc{
		Platform:       scan.Platform,
		FileName:       fileName,
		Body:           body,
		SizeBytes:      int64(len(body)),
		ContentHash:    hex.EncodeToString(hash[:]),
		FileCount:      len(scan.Files),
		DocumentKey:    docKey,
		IdempotencyKey: newIdempotencyKey(),
	}, nil
}

// escapeRelPath produces a value safe to embed inside the marker's
// double-quoted `rel="..."` attribute. We backslash-escape `\` and `"`
// and substitute control characters (\r, \n, \t, NUL) with explicit
// escape sequences so a hostile / typo'd file name cannot break the
// marker grammar that the backend reverse-splitter relies on. The
// scanner already drops files whose name contains \r or \n at the
// outer boundary, but escapeRelPath is still defensive — paths with
// embedded tabs (legal on Unix) or NUL (rare but possible on raw FS)
// would otherwise corrupt the merged document.
func escapeRelPath(rel string) string {
	rel = strings.ReplaceAll(rel, `\`, `\\`)
	rel = strings.ReplaceAll(rel, `"`, `\"`)
	rel = strings.ReplaceAll(rel, "\r", `\r`)
	rel = strings.ReplaceAll(rel, "\n", `\n`)
	rel = strings.ReplaceAll(rel, "\t", `\t`)
	rel = strings.ReplaceAll(rel, "\x00", `\0`)
	return rel
}

// buildDocumentKey mirrors the backend's stable derivation:
// "doc_" + sha256(sourceKey + ":" + logicalPath)[:32].
func buildDocumentKey(sourceKey, logicalPath string) string {
	sum := sha256.Sum256([]byte(sourceKey + ":" + logicalPath))
	return "doc_" + hex.EncodeToString(sum[:])[:32]
}

// normalizeLineEndings replaces \r\n with \n. Standalone \r (legacy mac)
// is also normalized for safety.
func normalizeLineEndings(in []byte) []byte {
	out := bytes.ReplaceAll(in, []byte("\r\n"), []byte("\n"))
	out = bytes.ReplaceAll(out, []byte("\r"), []byte("\n"))
	return out
}

// (WriteToTempFile and SanitizeRelPath were retired in the slimming
// pass — both had zero production callers. Reintroduce when an
// uploader path actually needs disk-buffered merge bodies or when
// merger-side path traversal becomes a concrete threat.)
