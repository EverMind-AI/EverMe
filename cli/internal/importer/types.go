// Package importer drives `evercli import scan / run` — scanning local
// AI-Agent memory files, merging them into a single markdown document,
// and uploading it via the EverMe presign-then-record flow.
//
// Three pipeline stages are independently testable:
//
//	scanner → []SourceScan
//	merger  → MergedDoc
//	uploader → RecordResult
//
// Service composes them.
package importer

import "time"

// PlatformID is the local-side platform tag (mirrors plugin.Platform).
// Re-declared here to avoid a circular import with internal/plugin.
type PlatformID string

const (
	PlatformClaudeCode PlatformID = "claude-code"
	PlatformOpenClaw   PlatformID = "openclaw"
)

// SourceScan is the scanner output for one platform.
type SourceScan struct {
	Platform     PlatformID  `json:"platform"`
	Type         string      `json:"type"` // "cold-start"
	RootPath     string      `json:"rootPath"`
	Files        []ScanFile  `json:"files"`
	TotalBytes   int64       `json:"totalBytes"`
	SkippedFiles []SkipEntry `json:"skippedFiles,omitempty"`
}

// ScanFile is one candidate file the scanner accepted.
type ScanFile struct {
	Path       string    `json:"path"`
	RelPath    string    `json:"relPath"`
	Title      string    `json:"title"`
	SizeBytes  int64     `json:"sizeBytes"`
	ModifiedAt time.Time `json:"modifiedAt"`
}

// SkipEntry records why a candidate was rejected. Surfaced in the scan
// envelope so users can debug "why is this file missing".
type SkipEntry struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

// ScanSummary is the abbreviated form returned by `import scan`.
type ScanSummary struct {
	Platform       PlatformID  `json:"platform"`
	Type           string      `json:"type"`
	RootPath       string      `json:"rootPath"`
	FileCount      int         `json:"fileCount"`
	TotalBytes     int64       `json:"totalBytes"`
	SampleTitles   []string    `json:"sampleTitles,omitempty"`
	SkippedCount   int         `json:"skippedCount,omitempty"`
	SkippedSamples []SkipEntry `json:"skippedSamples,omitempty"`
}

// MergedDoc is the output of merger.Merge — a single markdown blob plus
// its precomputed integrity hash and the deterministic documentKey.
type MergedDoc struct {
	Platform       PlatformID
	FileName       string // "cold-start-claude-code-20260421-173000.md"
	Body           []byte // utf-8 markdown
	SizeBytes      int64
	ContentHash    string // sha256 hex of Body
	FileCount      int
	DocumentKey    string // doc_<sha256(sourceKey:logicalPath)[:32]>
	IdempotencyKey string // UUID v4
}

// RecordResult is the per-platform success row in `import run`.
type RecordResult struct {
	Platform       PlatformID `json:"platform"`
	RecordID       string     `json:"recordId"`
	SourceID       string     `json:"sourceId,omitempty"`
	ObjectKey      string     `json:"objectKey"`
	FileCount      int        `json:"fileCount"`
	TotalBytes     int64      `json:"totalBytes"`
	MergedBytes    int64      `json:"mergedBytes"`
	ContentHash    string     `json:"contentHash"`
	DocumentKey    string     `json:"documentKey"`
	IdempotencyKey string     `json:"idempotencyKey"`
}
