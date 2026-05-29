package importer

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"time"

	"evercli/internal/client"
	"evercli/internal/core"
	"evercli/internal/logger"
	"evercli/internal/machineid"
	"evercli/internal/output"
)

// Service composes scan + merge + upload for the cmd layer.
type Service struct {
	cli      client.Client
	paths    *core.Paths
	apiBase  string
	scanners []Scanner
	upHTTP   *http.Client // injectable for tests
}

// NewService returns a Service backed by the production scanner registry.
func NewService(cli client.Client, paths *core.Paths, apiBase string) *Service {
	return &Service{
		cli:      cli,
		paths:    paths,
		apiBase:  apiBase,
		scanners: ScanRegistry(),
	}
}

// SetScanners overrides the scanner registry. Used by tests to point
// scanners at a tmp dir without env-var dance.
func (s *Service) SetScanners(scs []Scanner) { s.scanners = scs }

// SetUploadHTTPClient lets tests inject an in-process httptest client
// so the S3 PresignedPOST URL resolves without leaving the test binary.
func (s *Service) SetUploadHTTPClient(hc *http.Client) { s.upHTTP = hc }

// ---- Scan -----------------------------------------------------------

// Scan runs every registered scanner and returns the per-platform
// summaries. Output ordering matches scanner registration (alpha).
func (s *Service) Scan(ctx context.Context, exclude []string) ([]ScanSummary, error) {
	out := make([]ScanSummary, 0, len(s.scanners))
	for _, sc := range s.scanners {
		res, err := sc.Scan(ctx, exclude)
		if err != nil {
			return nil, err
		}
		out = append(out, res.ToSummary())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Platform < out[j].Platform })
	return out, nil
}

// ---- Run ------------------------------------------------------------

// RunOptions per-call knobs (mirrors the cmd flag set).
//
// SourceIDByPlatform was retired in the slimming pass — the field had
// zero CLI callers (the cmd layer never set it) and was a library-style
// extension point with no concrete consumer. The backend resolves the
// source via the registered agent's machineFingerprint; per-platform
// override is reintroducible if a future caller actually needs it.
type RunOptions struct {
	Platforms []PlatformID // empty → all detected scanners
	Resume    bool
	DryRun    bool
	Exclude   []string
}

// RunReport is the public import-run result envelope.
type RunReport struct {
	DryRun   bool            `json:"dryRun,omitempty"`
	Imports  []RecordResult  `json:"imports,omitempty"`
	Skipped  []RunSkip       `json:"skipped,omitempty"`
	Failed   []RunFail       `json:"failed,omitempty"`
	Previews []DryRunPreview `json:"previews,omitempty"`
}

// RunSkip captures "this platform had no files / wasn't requested".
type RunSkip struct {
	Platform PlatformID `json:"platform"`
	Reason   string     `json:"reason"`
}

// RunFail rewrites a CLIError into the per-platform error envelope.
type RunFail struct {
	Platform PlatformID `json:"platform"`
	Error    runFailErr `json:"error"`
}

type runFailErr struct {
	Type    output.ErrorType `json:"type"`
	Message string           `json:"message"`
	Hint    string           `json:"hint,omitempty"`
	Code    int              `json:"code,omitempty"`
}

// DryRunPreview is the shape returned when --dry-run is set.
type DryRunPreview struct {
	Platform    PlatformID `json:"platform"`
	FileCount   int        `json:"fileCount"`
	TotalBytes  int64      `json:"totalBytes"`
	MergedBytes int64      `json:"mergedBytes"`
	ContentHash string     `json:"contentHash"`
	DocumentKey string     `json:"documentKey"`
	WouldPostTo string     `json:"wouldPostTo"`
}

// Run executes the cold-start import for each requested platform. A
// per-platform failure is captured in Failed and the next platform is
// still attempted. Caller decides ok=false vs ok=true based on Failed.
func (s *Service) Run(ctx context.Context, opts RunOptions) (*RunReport, error) {
	platforms, err := s.resolvePlatforms(opts)
	if err != nil {
		return nil, err
	}
	rep := &RunReport{DryRun: opts.DryRun}

	for _, p := range platforms {
		s.runOne(ctx, p, opts, rep)
	}
	return rep, nil
}

func (s *Service) resolvePlatforms(opts RunOptions) ([]PlatformID, error) {
	if len(opts.Platforms) > 0 {
		// Validate against scanner registry.
		known := map[PlatformID]bool{}
		for _, sc := range s.scanners {
			known[sc.Platform()] = true
		}
		for _, p := range opts.Platforms {
			if !known[p] {
				return nil, output.Invalid(fmt.Sprintf("unknown platform %q", p), "")
			}
		}
		return opts.Platforms, nil
	}
	out := make([]PlatformID, 0, len(s.scanners))
	for _, sc := range s.scanners {
		out = append(out, sc.Platform())
	}
	return out, nil
}

// runOne is the per-platform body. Errors during scan/merge/upload are
// captured into rep.Failed; ctx-cancel is bubbled up by the caller's
// next iteration.
func (s *Service) runOne(ctx context.Context, p PlatformID, opts RunOptions, rep *RunReport) {
	scanner := s.findScanner(p)
	if scanner == nil {
		rep.Failed = append(rep.Failed, makeFail(p, output.Invalid(fmt.Sprintf("scanner not registered: %s", p), "")))
		return
	}

	scan, err := scanner.Scan(ctx, opts.Exclude)
	if err != nil {
		rep.Failed = append(rep.Failed, makeFail(p, err))
		return
	}
	if len(scan.Files) == 0 {
		rep.Skipped = append(rep.Skipped, RunSkip{Platform: p, Reason: "no files"})
		return
	}

	// SourceID is keyed per-(machine, user, platform) so the derived
	// documentKey doesn't collide across installs. Without this, every
	// machine importing the same platform (e.g. claude-code) ends up
	// sharing one documentKey at the backend, and the version chain
	// silently treats unrelated machines as revisions of one document.
	merged, err := Merge(scan, MergeOptions{
		SourceID: machineid.Fingerprint(string(p)),
	})
	if err != nil {
		rep.Failed = append(rep.Failed, makeFail(p, err))
		return
	}

	if opts.DryRun {
		rep.Previews = append(rep.Previews, DryRunPreview{
			Platform:    p,
			FileCount:   merged.FileCount,
			TotalBytes:  scan.TotalBytes,
			MergedBytes: merged.SizeBytes,
			ContentHash: merged.ContentHash,
			DocumentKey: merged.DocumentKey,
			WouldPostTo: "/mem/uploads/presign + /mem/records",
		})
		return
	}

	// Resume support: if a checkpoint exists for this platform, load
	// it (otherwise start fresh).
	ckPath := CheckpointPath(s.paths.CacheDir, p)
	var ck *Checkpoint
	if opts.Resume {
		ck, _ = LoadCheckpoint(ckPath)
	}
	if ck == nil {
		ck = &Checkpoint{}
	}

	uploader := s.uploader()
	res, err := uploader.Upload(ctx, UploadParams{
		Doc:     merged,
		APIBase: s.apiBase,
	}, ck)
	// Persist checkpoint regardless of outcome so partial progress is
	// recoverable. On success we delete it. A checkpoint-write failure
	// is not fatal — but we log a warning so a doctor / debug bundle
	// surfaces "your --resume won't work next time" instead of the
	// previous silent _ = SaveCheckpoint behavior.
	if cpErr := SaveCheckpoint(ckPath, ck); cpErr != nil {
		logger.L().Warnw("checkpoint save failed; --resume will start over",
			"platform", p,
			"path", ckPath,
			"err", cpErr.Error(),
		)
	}
	if err != nil {
		rep.Failed = append(rep.Failed, makeFail(p, err))
		return
	}
	_ = DeleteCheckpoint(ckPath)
	rep.Imports = append(rep.Imports, *res)
}

func (s *Service) findScanner(p PlatformID) Scanner {
	for _, sc := range s.scanners {
		if sc.Platform() == p {
			return sc
		}
	}
	return nil
}

func (s *Service) uploader() *Uploader {
	if s.upHTTP != nil {
		return NewUploaderWithHTTP(s.cli, s.upHTTP)
	}
	return NewUploader(s.cli)
}

func makeFail(p PlatformID, err error) RunFail {
	ce := output.ClassifyError(err)
	return RunFail{
		Platform: p,
		Error: runFailErr{
			Type:    ce.Type,
			Message: ce.Message,
			Hint:    ce.Hint,
			Code:    ce.Code,
		},
	}
}

// CleanupExpiredCheckpoints removes checkpoint files older than maxAge,
// plus any that fail to parse (leftover from a crashed run with a
// schema-mismatch). Wired into `evercli doctor --cleanup`.
func CleanupExpiredCheckpoints(cacheDir string, maxAge time.Duration, now time.Time) (int, error) {
	count := 0
	for _, p := range []PlatformID{PlatformClaudeCode, PlatformOpenClaw} {
		path := CheckpointPath(cacheDir, p)
		ck, err := LoadCheckpoint(path)
		if err != nil {
			// Unparseable checkpoint file — drop it. This includes the
			// "user upgraded to a newer evercli that changed the
			// Checkpoint shape" case.
			_ = DeleteCheckpoint(path)
			count++
			continue
		}
		if ck == nil {
			continue
		}
		if !ck.CreatedAt.IsZero() && now.Sub(ck.CreatedAt) > maxAge {
			_ = DeleteCheckpoint(path)
			count++
		}
	}
	return count, nil
}
