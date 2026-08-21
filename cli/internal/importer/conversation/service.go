package conversation

import (
	"context"
	"fmt"
	"os"
	"time"
)

// activeSessionWindow is how recent a file's mtime must be for it to be
// treated as the user's currently-open ("active") session. Such files are
// excluded from import because the live plugin already captures them — including
// them here would double-ingest the same conversation.
const activeSessionWindow = 5 * time.Minute

// StatusExtractionPending is the reported status when a session's data is on
// the server but extraction could not be triggered (mirrors the server's
// v1.AgentMemoryStatusExtractionPending). A --force re-run retries the flush.
const StatusExtractionPending = "extraction_pending"

// UploaderIface is the upload interface so a fake can substitute in tests.
type UploaderIface interface {
	Upload(ctx context.Context, evt string, conv *Conversation) (string, error)
	// UploadAsync sends every batch without sync or flush (fire-and-forget
	// adds); extraction is triggered later via FlushSession.
	UploadAsync(ctx context.Context, evt string, conv *Conversation) (string, error)
	// FlushSession sends a flush-only request for an already-uploaded session.
	FlushSession(ctx context.Context, evt, conversationID string) (string, error)
}

// ScanReport is the result of a Scan call.
type ScanReport struct {
	Items         []Item                `json:"items"`
	NotFound      map[PlatformID]string `json:"notFound,omitempty"`      // platform → hint string
	DriftWarnings []string              `json:"driftWarnings,omitempty"` // dir exists but 0 parseable items
	SkippedActive []string              `json:"skippedActive,omitempty"` // file paths excluded as active sessions
}

// ServiceDeps holds external dependencies for Service.
type ServiceDeps struct {
	// Registry is the scanner registry. Defaults to DefaultRegistry() if nil.
	Registry *Registry
	// Roots overrides the default scan roots per platform. If a platform is
	// not listed, DefaultRoots(platform) is used.
	Roots map[PlatformID][]string
	// StatePath is the path to the state JSON file. Only needed for Run.
	StatePath string
	// StateScope pins ledger entries to one account + environment; see
	// StateScope(). Only needed for Run.
	StateScope string
	// Uploader is used by RunOne to POST conversations. If nil, RunOne returns
	// an error.
	Uploader UploaderIface
	// EvtResolver resolves the per-platform agent token. Defaults to ResolveEvt
	// if nil.
	EvtResolver func(PlatformID) (string, error)
}

// RunOpts controls the behaviour of RunOne.
type RunOpts struct {
	Consented bool
	Force     bool
	// Async uploads via the fire-and-forget add path (no sync, no flush).
	// The caller is responsible for issuing FlushOne per session after the
	// whole run's adds are sent — deferring the flush is what keeps it from
	// racing async adds that have not landed upstream yet.
	Async bool
}

// RunResult is the per-conversation outcome of RunOne.
type RunResult struct {
	Status     string
	Skipped    bool
	SkipReason string
}

// Service orchestrates scan and run operations.
type Service struct {
	deps  ServiceDeps
	state *State // lazily loaded
}

// NewService creates a new Service with the given deps.
func NewService(deps ServiceDeps) *Service {
	if deps.Registry == nil {
		deps.Registry = DefaultRegistry()
	}
	return &Service{deps: deps}
}

// EnsureStateLoaded loads and caches the state, exposing it to callers that
// want to surface a corruption-recovery notice (State.RecoveredFrom) before
// the run loop begins. RunOne reuses the same cached state.
func (s *Service) EnsureStateLoaded() (*State, error) {
	return s.loadState()
}

// loadState loads (or returns the already-loaded) state from StatePath.
func (s *Service) loadState() (*State, error) {
	if s.state != nil {
		return s.state, nil
	}
	st, err := LoadState(s.deps.StatePath, s.deps.StateScope)
	if err != nil {
		return nil, err
	}
	s.state = st
	return st, nil
}

// stateKey returns the idempotency key for a conversation, incorporating
// both platform and path so that the same file scanned by two different
// platform scanners does not collide in the state store.
func stateKey(conv *Conversation) string {
	return ItemStateKey(conv.Item)
}

// RunOne uploads a single conversation, respecting consent and idempotency.
func (s *Service) RunOne(ctx context.Context, conv *Conversation, opts RunOpts) (*RunResult, error) {
	if !opts.Consented {
		return nil, fmt.Errorf("user consent required; run 'evercli import conversations run' interactively")
	}

	st, err := s.loadState()
	if err != nil {
		return nil, fmt.Errorf("load state: %w", err)
	}

	key := stateKey(conv)

	if st.ShouldSkip(key) && !opts.Force {
		return &RunResult{Skipped: true, SkipReason: "already submitted"}, nil
	}

	evtResolver := s.deps.EvtResolver
	if evtResolver == nil {
		evtResolver = ResolveEvt
	}

	attrib := AttributionPlatform(conv.Item)
	evt, err := evtResolver(attrib)
	if err != nil {
		st.MarkFailed(key, err.Error())
		_ = st.Save()
		return nil, fmt.Errorf("resolve evt for %s: %w", attrib, err)
	}

	if s.deps.Uploader == nil {
		return nil, fmt.Errorf("no uploader configured")
	}

	upload := s.deps.Uploader.Upload
	if opts.Async {
		upload = s.deps.Uploader.UploadAsync
	}
	status, err := upload(ctx, evt, conv)
	if err != nil {
		st.MarkFailed(key, err.Error())
		_ = st.Save()
		return nil, fmt.Errorf("upload %s: %w", conv.Item.Path, err)
	}

	// Async adds are only half the session: extraction still needs the
	// deferred flush. Marking submitted here would let a run interrupted
	// before its flush phase leave the session queued-but-never-flushed and
	// idempotently skipped forever — FlushOne marks instead.
	if !opts.Async {
		st.MarkSubmitted(key, conv.ID)
		if err := st.Save(); err != nil {
			return nil, fmt.Errorf("save state: %w", err)
		}
	}

	return &RunResult{Status: status}, nil
}

// FlushOne triggers extraction for a session whose adds were sent via the
// async path. A "no_extraction" answer usually means the async adds had not
// landed upstream when the flush arrived, so it retries exactly once after
// retryDelay; if the retry still reports no_extraction the session is
// surfaced as extraction_pending — the data is on the server, a later
// --force re-run retries the flush (same recovery as the sync path).
func (s *Service) FlushOne(ctx context.Context, conv *Conversation, retryDelay time.Duration) (*RunResult, error) {
	if s.deps.Uploader == nil {
		return nil, fmt.Errorf("no uploader configured")
	}
	evtResolver := s.deps.EvtResolver
	if evtResolver == nil {
		evtResolver = ResolveEvt
	}
	evt, err := evtResolver(AttributionPlatform(conv.Item))
	if err != nil {
		return nil, fmt.Errorf("resolve evt for %s: %w", AttributionPlatform(conv.Item), err)
	}
	status, err := s.deps.Uploader.FlushSession(ctx, evt, conv.ID)
	if err != nil {
		return nil, fmt.Errorf("flush %s: %w", conv.Item.Path, err)
	}
	if status == "no_extraction" {
		select {
		case <-time.After(retryDelay):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		status, err = s.deps.Uploader.FlushSession(ctx, evt, conv.ID)
		if err != nil {
			return nil, fmt.Errorf("flush retry %s: %w", conv.Item.Path, err)
		}
		if status == "no_extraction" {
			status = StatusExtractionPending
		}
	}

	// The flush completes an async session, so submitted is recorded here
	// (extraction_pending included — the data is on the server and a --force
	// re-run retries the flush, matching the sync path's semantics). A flush
	// that errored out entirely returns above without marking, so a plain
	// re-run re-sends the session (the server lands it on the same session id).
	st, err := s.loadState()
	if err != nil {
		return nil, fmt.Errorf("load state: %w", err)
	}
	st.MarkSubmitted(stateKey(conv), conv.ID)
	if err := st.Save(); err != nil {
		return nil, fmt.Errorf("save state: %w", err)
	}
	return &RunResult{Status: status}, nil
}

// roots returns the effective scan roots for a platform.
func (s *Service) roots(p PlatformID) []string {
	if r, ok := s.deps.Roots[p]; ok {
		return r
	}
	return DefaultRoots(p)
}

// Scan runs all requested platforms' scanners and returns a ScanReport.
// Missing dirs produce NotFound entries (not an error). Dirs that exist
// but yield 0 parseable items produce DriftWarnings.
func (s *Service) Scan(platforms []PlatformID) (*ScanReport, error) {
	rep := &ScanReport{
		NotFound: map[PlatformID]string{},
	}

	for _, p := range platforms {
		sc := s.deps.Registry.ScannerFor(p)
		if sc == nil {
			rep.DriftWarnings = append(rep.DriftWarnings,
				fmt.Sprintf("no scanner registered for platform %s", p))
			continue
		}

		roots := s.roots(p)

		// Check if all roots are missing
		allMissing := true
		anyExists := false
		for _, root := range roots {
			if _, err := os.Stat(root); err == nil {
				anyExists = true
				allMissing = false
				break
			}
		}

		if allMissing {
			hint := fmt.Sprintf("directory not found for %s (checked: %v); "+
				"use --path to specify a custom location or set %s",
				p, roots, envHintFor(p))
			rep.NotFound[p] = hint
			continue
		}

		items, err := sc.Scan(roots)
		if err != nil {
			return nil, fmt.Errorf("scan %s: %w", p, err)
		}

		if anyExists && len(items) == 0 {
			rep.DriftWarnings = append(rep.DriftWarnings,
				fmt.Sprintf("platform %s: directory exists but no parseable sessions found "+
					"(directory layout may have changed)", p))
		}

		// Populate message/toolcall counts via a best-effort Read pass.
		for i := range items {
			// A markdown file not under any known agent folder cannot be
			// attributed to an evt; mark it unsupported (excluded below).
			if items[i].Platform == PlatformMarkdown && items[i].OwnerPlatform == "" {
				items[i].Status = "unsupported"
				items[i].SkipReason = "markdown file is not under a known agent folder; cannot attribute"
				continue
			}
			if conv, rerr := sc.Read(items[i]); rerr == nil && conv != nil {
				items[i].MessageCount = len(conv.Messages)
				// Read derives StartedAt from the earliest message timestamp;
				// surface it so the preview date reflects the session, not mtime.
				if conv.Item.StartedAt != "" {
					items[i].StartedAt = conv.Item.StartedAt
				}
				tc, tr := 0, 0
				for _, m := range conv.Messages {
					tc += len(m.ToolCalls)
					if m.Role == "tool" {
						tr++
					}
				}
				items[i].ToolCallCount = tc
				items[i].ToolResultCount = tr
				// The server rejects empty messages ("messages must contain
				// 1-500 items"); a 0-message parse (e.g. wrong-platform file)
				// must never be offered for upload.
				if items[i].MessageCount == 0 && items[i].Status != "unsupported" {
					items[i].Status = "unsupported"
					items[i].SkipReason = "no parseable messages"
				}
			} else if rerr != nil {
				items[i].Status = "unsupported"
				items[i].SkipReason = "parse failed during scan"
			}
		}

		// Exclude any item whose underlying file is still being written (mtime
		// within activeSessionWindow) — the live plugin already captures it.
		// Also exclude items marked unsupported above so they are never offered
		// for upload nor counted in the consentable set.
		now := time.Now()
		for _, it := range items {
			if it.Status == "unsupported" {
				continue
			}
			if isActiveSession(it.Path, now) {
				rep.SkippedActive = append(rep.SkippedActive, it.Path)
				continue
			}
			rep.Items = append(rep.Items, it)
		}
	}

	return rep, nil
}

// isActiveSession reports whether the file at path was modified within
// activeSessionWindow of now (i.e. likely still being written). Unstattable
// files are treated as not-active so they still surface in the preview.
func isActiveSession(path string, now time.Time) bool {
	fi, err := os.Stat(path)
	if err != nil {
		return false
	}
	return now.Sub(fi.ModTime()) < activeSessionWindow
}

// envHintFor returns an env var name that can override the default root
// for the given platform.
func envHintFor(p PlatformID) string {
	switch p {
	case PlatformClaudeCode:
		return "CLAUDE_CONFIG_DIR"
	case PlatformCodex:
		return "CODEX_HOME"
	default:
		return "the corresponding home environment variable"
	}
}
