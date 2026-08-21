package imports

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/mattn/go-isatty"
	"github.com/spf13/cobra"

	"evercli/internal/auth"
	"evercli/internal/cmdctx"
	"evercli/internal/importer/conversation"
	"evercli/internal/output"
	"evercli/internal/runctx"
)

// ---------------------------------------------------------------------------
// Session timeout floor (pure functions)
// ---------------------------------------------------------------------------

// syncImportSessionTimeoutFloor bounds a single session's sync upload+flush.
// The sync path blocks until server-side extraction triggers, so the global
// --timeout default (tuned for quick API calls) is far too tight here.
const syncImportSessionTimeoutFloor = 5 * time.Minute

// effectiveSessionTimeout floors a configured timeout at the sync import
// minimum. If configured is non-positive (unlimited), it is returned unchanged.
// If configured is between 0 (exclusive) and the floor, it is raised to the floor.
// Otherwise, the configured value is returned.
func effectiveSessionTimeout(configured time.Duration) time.Duration {
	if configured > 0 && configured < syncImportSessionTimeoutFloor {
		return syncImportSessionTimeoutFloor
	}
	return configured
}

// statusExtractionPending is the RunResult.Status the server reports when a
// session's upload (add) succeeded but the final flush failed to trigger
// extraction upstream. The data landed; extraction was merely deferred, not
// lost — but a plain success line would hide that from the user.
const statusExtractionPending = "extraction_pending"

// asyncFlushRetryDelay is how long FlushOne waits before its single retry
// when a flush reports no_extraction — usually a sign the session's async
// adds had not landed upstream yet when the flush arrived.
const asyncFlushRetryDelay = 5 * time.Second

// isExtractionDeferred reports whether a session's upload result status is
// the deferred-extraction status, so the run loop can surface an extra
// warning instead of treating it like any other success.
func isExtractionDeferred(status string) bool {
	return status == statusExtractionPending
}

// ---------------------------------------------------------------------------
// View types (pure data; testable without cobra)
// ---------------------------------------------------------------------------

// scanItemView is a single session entry for the scan table.
type scanItemView struct {
	Platform  string `json:"platform"`
	Path      string `json:"path"`
	Date      string `json:"date"`
	Messages  int    `json:"messages"`
	ToolCalls int    `json:"toolCalls"`
	Status    string `json:"status,omitempty"`
}

// scanView is the full scan render payload. Items is the full per-session
// detail (machine-read; used for per-item --exclude); Groups is the compact,
// consent-oriented summary rendered to humans by default.
type scanView struct {
	Items         []scanItemView    `json:"items"`
	Summary       scanSummaryView   `json:"summary"`
	Groups        []scanGroupView   `json:"groups,omitempty"`
	NotFound      map[string]string `json:"notFound,omitempty"`
	DriftWarnings []string          `json:"driftWarnings,omitempty"`
	SkippedActive []string          `json:"skippedActive,omitempty"`
}

// scanSummaryView is an additive scanView field (spec E3 §3): how many of the
// previewed sessions are new, already submitted per local idempotency state,
// or unsupported. Additive only — never rename/remove existing envelope
// fields; this is a new one.
type scanSummaryView struct {
	New              int `json:"new"`
	AlreadySubmitted int `json:"alreadySubmitted"`
	Unsupported      int `json:"unsupported"`
}

// summarizeScanItems counts items by status for scanView.Summary.
func summarizeScanItems(items []conversation.Item) scanSummaryView {
	var s scanSummaryView
	for _, it := range items {
		switch it.Status {
		case "submitted":
			s.AlreadySubmitted++
		case "unsupported":
			s.Unsupported++
		default:
			s.New++
		}
	}
	return s
}

// ---------------------------------------------------------------------------
// Idempotency state annotation (shared by scan and run — spec E3)
// ---------------------------------------------------------------------------

// loadIdempotencyState loads the local idempotency state file used to
// annotate scan/run items with their prior-submission status. A load failure
// (e.g. permission denied) is never fatal here: scan/run must keep working
// even without idempotency info — a warning is printed and callers fall back
// to stateless behavior (nil; nothing gets annotated). A corrupt file that
// LoadState already recovered from (backed up + reset) is also surfaced,
// since already-submitted sessions may re-upload after the reset.
func loadIdempotencyState(stderr io.Writer, path, scope string) *conversation.State {
	st, err := conversation.LoadState(path, scope)
	if err != nil {
		fmt.Fprintf(stderr, "warning: failed to load import state (%v); continuing without idempotency info\n", err)
		return nil
	}
	if st.RecoveredFrom != "" {
		fmt.Fprintf(stderr,
			"warning: import state was unreadable; backed up to %s and started fresh — already-submitted sessions may re-upload\n",
			st.RecoveredFrom)
	}
	if st.AdoptedLegacyEntries > 0 {
		fmt.Fprintf(stderr,
			"note: adopted %d import-state entries written before per-account tracking; they now belong to the account you are logged in as — pass --force to re-import if any of them were another account's\n",
			st.AdoptedLegacyEntries)
	}
	return st
}

// importStateScope pins the ledger to the account + environment doing the
// import. A missing/unreadable account.json still yields a stable scope
// for the environment: falling back to an empty identity would restore
// the cross-account bleed the scope exists to prevent.
func importStateScope(deps *cmdctx.Deps) string {
	accountID := ""
	if a, err := auth.LoadAccount(deps.Config.Paths.AccountFile()); err == nil && a != nil {
		accountID = a.AccountID
	}
	return conversation.StateScope(deps.Config.APIBaseURL, accountID)
}

// annotateSubmitted marks item.Status = "submitted" (in place) for every item
// already recorded as submitted in st, using the same platform+path key
// stateKey/RunOne derive (conversation.ItemStateKey). A nil st (the stateless
// fallback from a load failure) is a no-op.
func annotateSubmitted(items []conversation.Item, st *conversation.State) {
	if st == nil {
		return
	}
	for i := range items {
		if st.ShouldSkip(conversation.ItemStateKey(items[i])) {
			items[i].Status = "submitted"
		}
	}
}

// submittedPlan is what a run does about sessions the ledger already
// records as submitted for this account + environment.
type submittedPlan int

const (
	// submittedSkip drops them, as every run has always done.
	submittedSkip submittedPlan = iota
	// submittedReimport uploads them again.
	submittedReimport
	// submittedAsk puts the choice to the user before previewing.
	submittedAsk
)

// planForSubmitted decides between those three.
//
// Until now the only way to re-import was knowing that --force exists: a
// run printed "pass --force to re-upload" and moved on. An interactive
// user gets asked instead. A non-interactive one must not be — AI agents
// drive that path and a prompt there would hang the run.
func planForSubmitted(alreadySubmitted int, force, isTTY, noPrompt bool) submittedPlan {
	if force {
		return submittedReimport
	}
	if alreadySubmitted == 0 {
		return submittedSkip
	}
	if isTTY && !noPrompt {
		return submittedAsk
	}
	return submittedSkip
}

// readYes reads one line and reports whether it is an affirmative
// answer. Everything else — including EOF and a bare newline — is No, so
// a prompt can never default to doing the destructive thing.
func readYes(r io.Reader) bool {
	scanner := bufio.NewScanner(r)
	if !scanner.Scan() {
		return false
	}
	answer := strings.TrimSpace(strings.ToLower(scanner.Text()))
	return answer == "y" || answer == "yes"
}

// countSubmitted counts items annotated as already submitted.
func countSubmitted(items []conversation.Item) int {
	n := 0
	for _, it := range items {
		if it.Status == "submitted" {
			n++
		}
	}
	return n
}

// dropSubmittedUnlessForce removes items already annotated "submitted" from
// the set run() will upload, so a previously-imported session never consumes
// --limit's budget. force keeps today's meaning (re-upload everything) by
// skipping the drop entirely — RunOne's own force path still handles state
// bookkeeping per session. Returns the surviving items and how many were
// dropped, so the caller can print ONE stderr summary line instead of
// itemizing every skip.
func dropSubmittedUnlessForce(items []conversation.Item, force bool) (kept []conversation.Item, dropped int) {
	if force {
		return items, 0
	}
	kept = make([]conversation.Item, 0, len(items))
	for _, it := range items {
		if it.Status == "submitted" {
			dropped++
			continue
		}
		kept = append(kept, it)
	}
	return kept, dropped
}

// ---------------------------------------------------------------------------
// Render functions (pure: accept a view, return a string)
// ---------------------------------------------------------------------------

const privacyBanner = `
╔══════════════════════════════════════════════════════════════════════════╗
║  PRIVACY NOTICE (隐私提示)                                               ║
║  Local sessions and documents may contain secrets, PII, or confidential  ║
║  data. Uploading is irreversible. Automatic redaction runs but is NOT a   ║
║  guarantee. Review the file list above carefully before confirming.       ║
║  Run 'evercli import conversations run' when you are ready.               ║
╚══════════════════════════════════════════════════════════════════════════╝
`

// renderConversationScan renders a scan report. By default it prints the
// compact grouped summary (one row per project / zone). With detail=true it
// prints the full per-session table instead.
func renderConversationScan(v scanView, detail bool) string {
	var b strings.Builder

	if len(v.Items) == 0 && len(v.NotFound) == 0 {
		b.WriteString("No sessions found.\n")
		b.WriteString(privacyBanner)
		return b.String()
	}

	if detail {
		renderScanDetailTable(&b, v.Items)
	} else {
		renderScanGroupTable(&b, v.Groups, len(v.Items), v.Summary)
	}

	// Not-found notices
	if len(v.NotFound) > 0 {
		b.WriteString("Not found:\n")
		for platform, hint := range v.NotFound {
			b.WriteString(fmt.Sprintf("  [%s] %s\n", platform, hint))
		}
		b.WriteString("\n")
	}

	// Drift warnings
	for _, w := range v.DriftWarnings {
		b.WriteString(fmt.Sprintf("  WARNING: %s\n", w))
	}
	if len(v.DriftWarnings) > 0 {
		b.WriteString("\n")
	}

	// Active sessions skipped (still being written by the live plugin)
	for _, p := range v.SkippedActive {
		b.WriteString(fmt.Sprintf("  skipped (active session, still being written): %s\n", p))
	}
	if len(v.SkippedActive) > 0 {
		b.WriteString("\n")
	}

	b.WriteString(privacyBanner)
	return b.String()
}

// renderScanGroupTable writes the compact grouped summary: one row per
// project / zone with session+message counts and a date range, plus a totals
// line. totalSessions is the full per-session count behind the groups.
// summary appends the new/already-imported breakdown to the TOTAL line
// (spec E3 §3) so a user can tell "N new / M already imported" without
// switching to --detail.
func renderScanGroupTable(b *strings.Builder, groups []scanGroupView, totalSessions int, summary scanSummaryView) {
	if len(groups) == 0 {
		return
	}
	b.WriteString(fmt.Sprintf("%-12s  %-42s  %5s  %8s  %s\n",
		"PLATFORM", "AREA/PROJECT", "SESS", "MESSAGES", "DATE RANGE"))
	b.WriteString(strings.Repeat("-", 92) + "\n")
	totalMsgs := 0
	for _, g := range groups {
		totalMsgs += g.Messages
		area := g.Area
		if len(area) > 42 {
			area = "…" + area[len(area)-41:]
		}
		rng := g.DateFrom
		if g.DateFrom != g.DateTo && g.DateTo != "" {
			rng = g.DateFrom + "→" + g.DateTo
		}
		b.WriteString(fmt.Sprintf("%-12s  %-42s  %5d  %8d  %s\n",
			g.Platform, area, g.Sessions, g.Messages, rng))
	}
	b.WriteString(strings.Repeat("-", 92) + "\n")
	b.WriteString(fmt.Sprintf("TOTAL: %d groups · %d sessions · %d messages (%d new · %d imported)\n",
		len(groups), totalSessions, totalMsgs, summary.New, summary.AlreadySubmitted))
	b.WriteString("(run with --detail to list every session; --format json for machine detail)\n\n")
}

// renderScanDetailTable writes the full per-session table (one row per file).
func renderScanDetailTable(b *strings.Builder, items []scanItemView) {
	if len(items) == 0 {
		return
	}
	b.WriteString(fmt.Sprintf("%-14s  %-55s  %-12s  %8s  %9s  %s\n",
		"PLATFORM", "PATH", "DATE", "MESSAGES", "TOOLCALLS", "STATUS"))
	b.WriteString(strings.Repeat("-", 115) + "\n")
	for _, item := range items {
		status := item.Status
		if status == "" {
			status = "ready"
		}
		path := item.Path
		if len(path) > 55 {
			path = "..." + path[len(path)-52:]
		}
		b.WriteString(fmt.Sprintf("%-14s  %-55s  %-12s  %8d  %9d  %s\n",
			item.Platform, path, item.Date, item.Messages, item.ToolCalls, status))
	}
	b.WriteString("\n")
}

// ---------------------------------------------------------------------------
// Guard (consent / non-interactive policy)
// ---------------------------------------------------------------------------

type runGuardInput struct {
	IsTTY     bool
	NoPrompt  bool
	Platforms []string

	// DryRun bypasses the guard entirely: --dry-run uploads nothing (it
	// only scans and prints a preview), so the unattended-bulk-upload risk
	// this guard exists for never applies. Requiring --no-prompt +
	// --platform for a plain preview in CI/non-TTY use was an ECA E2E
	// finding — a harmless `run --dry-run` should never need them.
	DryRun bool
}

// runConversationsGuard enforces consent policy:
// - interactive TTY: allowed (caller will show preview + prompt)
// - dry-run: always allowed (no upload happens regardless of TTY/scope)
// - non-interactive without --no-prompt: refused
// - non-interactive with --no-prompt but no explicit platform: refused
// - non-interactive with --no-prompt and explicit platform(s): allowed
//
// The two refusal errors are input-validation errors (bad flags/invocation
// for this environment), not internal failures — output.Invalid maps them
// to error.type=validation / exit code 2 instead of the misleading
// error.type=internal a bare fmt.Errorf would produce.
func runConversationsGuard(input runGuardInput) error {
	if input.DryRun {
		return nil // no upload happens; the guard's risk doesn't apply
	}
	if input.IsTTY {
		return nil // interactive: will prompt
	}
	if !input.NoPrompt {
		return output.Invalid(
			"non-interactive session detected; use --no-prompt with an explicit platform scope "+
				"(e.g. --platform claude-code) to run without a TTY",
			"")
	}
	if len(input.Platforms) == 0 {
		return output.Invalid(
			"--no-prompt requires an explicit platform scope "+
				"(e.g. --platform claude-code) to prevent accidental bulk import in CI",
			"")
	}
	return nil
}

// ---------------------------------------------------------------------------
// cobra command wiring
// ---------------------------------------------------------------------------

func newConversations() *cobra.Command {
	c := &cobra.Command{
		Use:   "conversations",
		Short: "Import agent conversation sessions (Claude Code, Codex, Hermes, OpenClaw, Markdown, Kimi Code, Raven)",
	}
	c.AddCommand(newConversationsScan())
	c.AddCommand(newConversationsRun())
	return c
}

func newConversationsScan() *cobra.Command {
	var (
		platforms []string
		paths     []string
		detail    bool
		since     string
		until     string
		limit     int
	)
	c := &cobra.Command{
		Use:   "scan [platform...]",
		Short: "Preview local agent sessions that can be imported (no upload)",
		Long: `Scan walks per-platform session directories and lists each discovered session
with its file path, date, message/tool counts, and status.

No files are uploaded. A prominent privacy notice is printed to remind you that
sessions may contain secrets or personal data before you run 'conversations run'.

Sessions already recorded as submitted in local idempotency state show
STATUS=submitted (--detail) and are counted in the "summary" field
(new / alreadySubmitted / unsupported) and the grouped TOTAL line — unlike
'run', scan never drops them, so you still see the full picture.

Missing platforms are announced explicitly — they are never silently empty.
Use --path to override the scan root for a specific platform.`,
		Example: `  evercli import conversations scan
  evercli import conversations scan claude-code codex
  evercli import conversations scan --format json`,
		RunE: func(cmd *cobra.Command, args []string) error {
			deps, err := cmdctx.BuildDeps(cmd)
			if err != nil {
				return deps.Out.Err(err)
			}

			// Determine which platforms to scan
			requested := args
			if len(platforms) > 0 {
				requested = append(requested, platforms...)
			}
			var platformIDs []conversation.PlatformID
			if len(requested) == 0 {
				// Default: all platforms
				reg := conversation.DefaultRegistry()
				for _, sc := range reg.Scanners() {
					platformIDs = append(platformIDs, sc.Platform())
				}
			} else {
				ids, perr := conversation.ParsePlatforms(requested)
				if perr != nil {
					return deps.Out.Err(output.Invalid(perr.Error(), "Use one of: claude-code, codex, hermes, openclaw, markdown, kimicode, raven, workbuddy"))
				}
				platformIDs = ids
			}

			if err := conversation.ValidateSince(since); err != nil {
				return deps.Out.Err(err)
			}
			if until != "" {
				if _, perr := time.Parse("2006-01-02", until); perr != nil {
					return deps.Out.Err(output.Invalid(
						fmt.Sprintf("--until must be YYYY-MM-DD, got %q", until), ""))
				}
			}

			// Build custom roots from --path overrides (format: platform=path)
			customRoots := map[conversation.PlatformID][]string{}
			for _, p := range paths {
				parts := strings.SplitN(p, "=", 2)
				if len(parts) != 2 {
					fmt.Fprintf(cmd.ErrOrStderr(), "--path %q: expected format platform=path, ignoring\n", p)
					continue
				}
				pid := conversation.PlatformID(strings.TrimSpace(parts[0]))
				customRoots[pid] = append(customRoots[pid], strings.TrimSpace(parts[1]))
			}

			cleanup, platformIDs, herr := bridgeHermes(cmd, len(requested) == 0, platformIDs, customRoots, until)
			if herr != nil {
				return deps.Out.Err(herr)
			}
			defer cleanup()

			svc := conversation.NewService(conversation.ServiceDeps{
				Roots: customRoots,
			})

			rep, err := svc.Scan(platformIDs)
			if err != nil {
				return deps.Out.Err(err)
			}

			// Annotate items already recorded as submitted (spec E3 §1) so the
			// preview shows the full picture — scan does NOT drop them, only
			// `run` does; see below.
			statePath := deps.Config.Paths.DataDir + "/conversations_import_state.json"
			stateScope := importStateScope(deps)
			st := loadIdempotencyState(cmd.ErrOrStderr(), statePath, stateScope)
			annotateSubmitted(rep.Items, st)

			// Apply --since then --limit so scan previews the same set (and order)
			// `run --since --limit` would upload.
			items := conversation.FilterItemsSince(rep.Items, since)
			if limit > 0 {
				items = conversation.SortItemsNewestFirst(items)
			}
			items = conversation.LimitItems(items, limit)

			// Build the view (full detail + compact groups summary)
			view := buildScanView(rep, items)

			deps.Out.WithTextRenderer(func(w io.Writer, data interface{}) error {
				sv, ok := data.(scanView)
				if !ok {
					_, err := fmt.Fprintln(w, "(no scan data)")
					return err
				}
				_, err := fmt.Fprint(w, renderConversationScan(sv, detail))
				return err
			})

			return deps.Out.OK(view, &output.Meta{Count: len(items)})
		},
	}
	c.Flags().StringSliceVar(&platforms, "platform", nil, "platforms to scan (default: all)")
	c.Flags().StringSliceVar(&paths, "path", nil, "override scan root: platform=path (e.g. claude-code=/custom/dir)")
	c.Flags().BoolVar(&detail, "detail", false, "list every session instead of the grouped summary")
	c.Flags().StringVar(&since, "since", "", "only preview sessions updated on or after YYYY-MM-DD")
	c.Flags().StringVar(&until, "until", "", "hermes only: import sessions that ended before YYYY-MM-DD (cold-start upper bound)")
	c.Flags().IntVar(&limit, "limit", 0, "preview at most the N most recent sessions (0 = unlimited; applied after --since)")
	return c
}

func newConversationsRun() *cobra.Command {
	var (
		dryRun    bool
		platforms []string
		since     string
		until     string
		limit     int
		force     bool
		noPrompt  bool
		paths     []string
		exclude   []string
		detail    bool
		async     bool
	)
	c := &cobra.Command{
		Use:   "run [platform...]",
		Short: "Upload discovered agent sessions to EverMe memory",
		Long: `Run scans local agent sessions and uploads them to EverMe agent-memory.

Each platform writes under its own identity (per-platform evt token).
Upload is synchronous by default: each session is added with sync batches and
flushed at the end, so extraction has been triggered by the time a session
reports done. This is slower than the old fire-and-forget path but results
are visible in Memory Hub as soon as each session completes. If the server
reports a session as "extraction_pending", the upload landed but extraction
was deferred upstream. Very large sessions may need a higher --timeout; each
session gets at least a 5-minute budget.

--async switches to the bulk path meant for large backgrounds imports: every
session's batches are sent fire-and-forget (the server ACKs "queued"
immediately), and only after ALL sessions are uploaded does the run issue one
flush per session to trigger extraction. Deferring the flushes keeps them
from racing async adds that have not landed upstream yet; a flush that still
reports no extraction is retried once and then surfaced as
extraction_pending (re-run with --force to retry the flush later). Sessions
reported "queued" are still being processed server-side — memories appear on
the page progressively, not by the time the command exits.

Sessions already marked submitted in local idempotency state are dropped
before --limit selects the N most recent, so a previously-imported session
never eats into your --limit budget; the drop is summarized in one stderr
line rather than listed session-by-session. --force disables the drop and
re-uploads everything, including sessions marked submitted.

In an interactive terminal, a preview table and privacy notice are shown
before prompting for confirmation. In CI / non-interactive use, pass
--no-prompt together with an explicit --platform scope.

Flags:
  --dry-run      Scan and print preview; do not upload anything.
  --platform     Limit to specific platform(s) (repeatable).
  --since        Only include sessions updated on or after this date (YYYY-MM-DD).
  --limit        Upload at most the N most recent sessions (0 = unlimited; applied
                 after --since and after dropping previously-imported sessions).
  --force        Re-upload even sessions already marked submitted (also skips the
                 pre-limit drop, so submitted sessions can consume --limit again).
  --no-prompt    Skip interactive confirmation (requires --platform).
  --path         Override scan root: platform=path (repeatable).
  --exclude      Exclude a specific session by path (repeatable; use the path shown in scan).
  --async        Fire-and-forget adds for every session first, then one flush per
                 session at the end (fast bulk path; sessions report "queued").`,
		Example: `  evercli import conversations run
  evercli import conversations run --platform claude-code --dry-run
  evercli import conversations run --platform claude-code --no-prompt
  evercli import conversations run --platform claude-code --no-prompt --async`,
		RunE: func(cmd *cobra.Command, args []string) error {
			deps, err := cmdctx.BuildDeps(cmd)
			if err != nil {
				return deps.Out.Err(err)
			}

			// Merge positional args + --platform flag
			effectivePlatforms := append(args, platforms...)

			isTTY := isatty.IsTerminal(os.Stdin.Fd())

			if err := runConversationsGuard(runGuardInput{
				IsTTY:     isTTY,
				NoPrompt:  noPrompt,
				Platforms: effectivePlatforms,
				DryRun:    dryRun,
			}); err != nil {
				return deps.Out.Err(err)
			}

			// Build platform IDs
			var platformIDs []conversation.PlatformID
			if len(effectivePlatforms) == 0 {
				reg := conversation.DefaultRegistry()
				for _, sc := range reg.Scanners() {
					platformIDs = append(platformIDs, sc.Platform())
				}
			} else {
				ids, perr := conversation.ParsePlatforms(effectivePlatforms)
				if perr != nil {
					return deps.Out.Err(output.Invalid(perr.Error(), "Use one of: claude-code, codex, hermes, openclaw, markdown, kimicode, raven, workbuddy"))
				}
				platformIDs = ids
			}

			// Fix 4: validate --since format before doing any work
			if err := conversation.ValidateSince(since); err != nil {
				return deps.Out.Err(err)
			}
			if until != "" {
				if _, perr := time.Parse("2006-01-02", until); perr != nil {
					return deps.Out.Err(output.Invalid(
						fmt.Sprintf("--until must be YYYY-MM-DD, got %q", until), ""))
				}
			}

			// Build custom roots from --path overrides (format: platform=path)
			customRoots := map[conversation.PlatformID][]string{}
			for _, p := range paths {
				parts := strings.SplitN(p, "=", 2)
				if len(parts) != 2 {
					fmt.Fprintf(cmd.ErrOrStderr(), "--path %q: expected format platform=path, ignoring\n", p)
					continue
				}
				pid := conversation.PlatformID(strings.TrimSpace(parts[0]))
				customRoots[pid] = append(customRoots[pid], strings.TrimSpace(parts[1]))
			}

			cleanup, platformIDs, herr := bridgeHermes(cmd, len(effectivePlatforms) == 0, platformIDs, customRoots, until)
			if herr != nil {
				return deps.Out.Err(herr)
			}
			defer cleanup()

			svc := conversation.NewService(conversation.ServiceDeps{
				Roots: customRoots,
			})

			rep, err := svc.Scan(platformIDs)
			if err != nil {
				return deps.Out.Err(err)
			}

			// Annotate items already recorded as submitted (spec E3 §1), then drop
			// them before --limit selection (spec E3 §2) so a previously-imported
			// session never eats into the --limit budget by getting counted here
			// and then skipped one-by-one later by RunOne. statePath is reused
			// below for runSvc so both the preview annotation and the actual
			// upload/skip decisions read the same state file.
			statePath := deps.Config.Paths.DataDir + "/conversations_import_state.json"
			stateScope := importStateScope(deps)
			st := loadIdempotencyState(cmd.ErrOrStderr(), statePath, stateScope)
			annotateSubmitted(rep.Items, st)

			// Fix 3: apply --since BEFORE --limit so limit acts on the filtered set
			items := conversation.FilterItemsSince(rep.Items, since)

			// Fix 2 (per-item exclusion, spec §7.0.2): resolve --exclude against
			// the full since-filtered set — BEFORE dropSubmittedUnlessForce and
			// BEFORE --limit — so excluding an already-submitted session (or one
			// --limit would never have reached) still matches instead of a false
			// "matched no session" warning (E3 review finding: dropping submitted
			// items first made a real match look unmatched). --exclude always
			// drops unconditionally, including under --force: force only
			// disables the *submitted* drop below, not user-requested exclusion.
			var excluded, unmatchedExcl, ambiguousExcl []string
			items, excluded, unmatchedExcl, ambiguousExcl = applyExcludePaths(items, exclude)
			for _, p := range excluded {
				fmt.Fprintf(cmd.ErrOrStderr(), "excluded by --exclude: %s\n", p)
			}
			for _, e := range unmatchedExcl {
				fmt.Fprintf(cmd.ErrOrStderr(), "warning: --exclude %q matched no session\n", e)
			}
			for _, e := range ambiguousExcl {
				fmt.Fprintf(cmd.ErrOrStderr(), "warning: --exclude %q is ambiguous (matches multiple sessions by filename); pass the full session path shown in scan\n", e)
			}

			// Decide what to do about already-imported sessions before
			// dropping them, so the preview and --limit budget reflect the
			// answer.
			reimport := force
			switch planForSubmitted(countSubmitted(items), force, isTTY, noPrompt) {
			case submittedReimport:
				reimport = true
			case submittedAsk:
				fmt.Fprintf(cmd.ErrOrStderr(),
					"%d session(s) were already imported for this account. Import them again? [y/N]: ",
					countSubmitted(items))
				reimport = readYes(os.Stdin)
			case submittedSkip:
			}

			var skippedSubmitted int
			items, skippedSubmitted = dropSubmittedUnlessForce(items, reimport)

			if limit > 0 {
				items = conversation.SortItemsNewestFirst(items)
			}
			items = conversation.LimitItems(items, limit)
			if skippedSubmitted > 0 {
				fmt.Fprintf(cmd.ErrOrStderr(), "skipped %d previously imported session(s); pass --force to re-upload\n", skippedSubmitted)
			}

			// Build scan view for preview
			view := buildScanView(rep, items)

			// Dry-run: render and return early
			if dryRun {
				fmt.Fprint(cmd.OutOrStdout(), renderConversationScan(view, detail))
				fmt.Fprintln(cmd.OutOrStdout(), "DRY RUN: no files uploaded.")
				return nil
			}

			// Show preview + privacy banner and prompt for confirmation only when
			// interactive AND --no-prompt was not given. --no-prompt (with an
			// explicit platform, enforced by the guard) skips confirmation even in
			// a TTY; a non-interactive session is already gated by the guard.
			consented := false
			if needsConfirm(isTTY, noPrompt) {
				fmt.Fprint(cmd.ErrOrStderr(), renderConversationScan(view, detail))
				fmt.Fprint(cmd.ErrOrStderr(), "Confirm import? [y/N]: ")
				consented = readYes(os.Stdin)
				if !consented {
					fmt.Fprintln(cmd.ErrOrStderr(), "Import cancelled. Run 'evercli import conversations run' again when ready.")
					return nil
				}
			} else {
				// --no-prompt (TTY or not) with an explicit platform — guard checked.
				consented = true
			}

			// Fix 1: wire Uploader so the run path does not nil-panic. Reuses
			// statePath from the annotation step above (same file, same
			// corruption-recovery warning already surfaced by
			// loadIdempotencyState there — no need to re-check here).
			runSvc := conversation.NewService(conversation.ServiceDeps{
				Roots:      customRoots,
				StatePath:  statePath,
				StateScope: stateScope,
				Uploader:   conversation.NewUploader(deps.Config.APIBaseURL, nil),
				// EvtResolver nil → RunOne defaults to conversation.ResolveEvt
			})

			// Detach from the shared command deadline (see per-session note
			// in the loop). base is the un-deadlined signal source — cancelled
			// only by a genuine SIGINT — and perSessionTimeout re-applies the
			// configured --timeout to each session in isolation.
			base := runctx.BaseContext(cmd.Context())
			perSessionTimeout := effectiveSessionTimeout(cmdctx.Snapshot().Timeout)

			// Run each item. Track upload failures so the command can exit
			// non-zero (CI must be able to detect a partially-failed bulk run).
			// In --async mode this loop is phase 1 (fire-and-forget adds);
			// successfully-added conversations queue up for the phase-2 flush
			// pass below, which runs only after EVERY add has been sent so a
			// flush never races an async add that has not landed upstream.
			failedCount := 0
			var toFlush []*conversation.Conversation
			reg := conversation.DefaultRegistry()
			for _, item := range items {
				sc := reg.ScannerFor(item.Platform)
				if sc == nil {
					fmt.Fprintf(cmd.ErrOrStderr(), "  [%s] %s → no scanner, skipped\n", item.Platform, item.Path)
					continue
				}
				conv, readErr := sc.Read(item)
				if readErr != nil {
					fmt.Fprintf(cmd.ErrOrStderr(), "  [%s] %s → read error: %v\n", item.Platform, item.Path, readErr)
					continue
				}
				// Defense-in-depth: the server rejects empty messages, so never
				// POST a 0-message conversation.
				if len(conv.Messages) == 0 {
					fmt.Fprintf(cmd.ErrOrStderr(), "  [%s] %s → skipped (no parseable messages)\n", item.Platform, item.Path)
					continue
				}

				// run is a bulk, long-running upload. BuildDeps wrapped
				// cmd.Context() with the global --timeout as ONE budget for the
				// whole command; sharing it across this sequential loop fails
				// every session once cumulative wall-clock crosses the deadline
				// (queued ... then a contiguous block of "context deadline
				// exceeded"). Bound each session independently instead, derived
				// from the un-deadlined signal source so SIGINT still aborts.
				if err := base.Err(); err != nil {
					fmt.Fprintf(cmd.ErrOrStderr(), "import aborted: %v\n", err)
					break
				}
				sessCtx, cancel := perSessionContext(cmd.Context(), perSessionTimeout)
				res, runErr := runSvc.RunOne(sessCtx, conv, conversation.RunOpts{
					Consented: consented,
					// reimport, not force: an interactive "yes" to the
					// already-imported prompt must reach RunOne's own skip
					// check too, or it would drop every session the prompt
					// just kept.
					Force: reimport,
					Async: async,
				})
				cancel()
				if runErr != nil {
					failedCount++
					fmt.Fprintf(cmd.OutOrStdout(), "  [%s] %s → failed: %v\n", item.Platform, item.Path, runErr)
					continue
				}
				if res.Skipped {
					fmt.Fprintf(cmd.OutOrStdout(), "  [%s] %s → skipped (%s)\n",
						item.Platform, item.Path, res.SkipReason)
				} else {
					fmt.Fprintf(cmd.OutOrStdout(), "  [%s] %s → %s\n",
						item.Platform, item.Path, res.Status)
					if isExtractionDeferred(res.Status) {
						fmt.Fprintf(cmd.ErrOrStderr(), "  warning: [%s] %s → upload landed but extraction was deferred upstream (extraction_pending); data is safe on the server\n", item.Platform, item.Path)
					}
					if async {
						toFlush = append(toFlush, conv)
					}
				}
			}

			// Phase 2 (--async only): one flush per successfully-added session.
			// The data of a failed flush is already on the server; report it
			// as extraction_pending rather than a failed upload.
			for _, conv := range toFlush {
				if err := base.Err(); err != nil {
					fmt.Fprintf(cmd.ErrOrStderr(), "flush pass aborted: %v\n", err)
					break
				}
				sessCtx, cancel := perSessionContext(cmd.Context(), perSessionTimeout)
				res, flushErr := runSvc.FlushOne(sessCtx, conv, asyncFlushRetryDelay)
				cancel()
				if flushErr != nil {
					fmt.Fprintf(cmd.OutOrStdout(), "  [%s] %s → extraction_pending\n", conv.Item.Platform, conv.Item.Path)
					fmt.Fprintf(cmd.ErrOrStderr(), "  warning: [%s] %s → flush failed (%v); data is safe on the server and the session stays unmarked — re-run the same command to retry\n", conv.Item.Platform, conv.Item.Path, flushErr)
					continue
				}
				fmt.Fprintf(cmd.OutOrStdout(), "  [%s] %s → %s\n", conv.Item.Platform, conv.Item.Path, res.Status)
				if isExtractionDeferred(res.Status) {
					fmt.Fprintf(cmd.ErrOrStderr(), "  warning: [%s] %s → upload landed but extraction was deferred upstream (extraction_pending); data is safe on the server\n", conv.Item.Platform, conv.Item.Path)
				}
			}

			if e := runExitError(failedCount, len(items)); e != nil {
				return deps.Out.Err(e)
			}
			return nil
		},
	}
	c.Flags().BoolVar(&dryRun, "dry-run", false, "scan and print preview; do not upload")
	c.Flags().StringSliceVar(&platforms, "platform", nil, "platforms to include (default: all)")
	c.Flags().StringVar(&since, "since", "", "only include sessions updated on or after YYYY-MM-DD")
	c.Flags().StringVar(&until, "until", "", "hermes only: import sessions that ended before YYYY-MM-DD (cold-start upper bound)")
	c.Flags().IntVar(&limit, "limit", 0, "upload at most the N most recent sessions (0 = unlimited; applied after --since and after dropping previously-imported sessions)")
	c.Flags().BoolVar(&force, "force", false, "re-upload even sessions already marked submitted (also skips the pre-limit drop)")
	c.Flags().BoolVar(&noPrompt, "no-prompt", false, "skip interactive confirmation (requires --platform)")
	c.Flags().StringSliceVar(&paths, "path", nil, "override scan root: platform=path (repeatable)")
	c.Flags().StringSliceVar(&exclude, "exclude", nil, "exclude a session by full path or filename (repeatable; matches the path or filename shown in scan)")
	c.Flags().BoolVar(&detail, "detail", false, "list every session instead of the grouped summary")
	c.Flags().BoolVar(&async, "async", false, "fire-and-forget adds for all sessions, then one flush per session at the end (fast bulk path)")
	return c
}

// perSessionContext derives a fresh, independently-bounded context for a
// single session's upload. It builds off the un-deadlined signal source
// stashed by cmdctx (via runctx.BaseContext) rather than the parent's global
// --timeout deadline, so a long bulk run does not accumulate one shared budget
// across sessions — each session gets the full timeout, while a genuine SIGINT
// (which cancels the base source) still aborts the whole run. timeout <= 0
// yields an un-deadlined context (matching --timeout 0). The returned cancel
// must always be called.
func perSessionContext(parent context.Context, timeout time.Duration) (context.Context, context.CancelFunc) {
	base := runctx.BaseContext(parent)
	if timeout <= 0 {
		return context.WithCancel(base)
	}
	return context.WithTimeout(base, timeout)
}

// applyExcludePaths drops every item the user excluded via --exclude, returning
// the surviving items, the full paths actually excluded (for user-facing
// notes), and the --exclude values that matched nothing (so the caller can warn
// instead of silently ignoring them — the TC-IMPORT-017 failure).
//
// A value matches an item when it equals the item's full path OR shares a
// basename that is UNIQUE across the candidate set. Basename matching keeps the
// scan-preview path usable (the preview abbreviates long paths to "...suffix",
// so a human copying the filename would never match on exact equality), but it
// is disabled for a basename shared by multiple sessions: kimicode transcripts
// are all named "wire.jsonl" (identity lives in the session_<uuid> dir), so a
// basename match there would collide with every session and drop them all.
// Shared basenames therefore require an exact full-path match; the excluded
// list always reports the resolved full path.
func applyExcludePaths(items []conversation.Item, exclude []string) (kept []conversation.Item, excluded []string, unmatched []string, ambiguous []string) {
	if len(exclude) == 0 {
		return items, nil, nil, nil
	}
	// Count basenames so basename matching only applies when a basename
	// uniquely identifies a session; a basename shared by >1 item (e.g. every
	// kimicode session's "wire.jsonl") must not match by basename, or excluding
	// one session would drop them all.
	baseCount := make(map[string]int, len(items))
	for _, it := range items {
		baseCount[filepath.Base(it.Path)]++
	}
	matched := make([]bool, len(exclude))  // dropped via exact path or unique basename
	collided := make([]bool, len(exclude)) // basename matched >1 session (ambiguous, not dropped)
	kept = make([]conversation.Item, 0, len(items))
	for _, it := range items {
		base := filepath.Base(it.Path)
		drop := false
		for i, e := range exclude {
			e = strings.TrimSpace(e)
			if e == "" {
				continue
			}
			if it.Path == e {
				drop = true
				matched[i] = true
				continue
			}
			if base == filepath.Base(e) {
				if baseCount[base] == 1 {
					drop = true
					matched[i] = true
				} else {
					collided[i] = true
				}
			}
		}
		if drop {
			excluded = append(excluded, it.Path)
			continue
		}
		kept = append(kept, it)
	}
	for i, e := range exclude {
		e = strings.TrimSpace(e)
		switch {
		case matched[i]:
			// dropped by exact path or unique basename; no warning
		case collided[i]:
			ambiguous = append(ambiguous, e)
		default:
			unmatched = append(unmatched, e)
		}
	}
	return kept, excluded, unmatched, ambiguous
}

// needsConfirm reports whether the run command should pause for the interactive
// "Confirm import? [y/N]" prompt. --no-prompt suppresses it even in a TTY (the
// screenshot showed `run ... --no-prompt` still prompting); a non-interactive
// session never prompts (the guard already gated it on an explicit platform).
func needsConfirm(isTTY, noPrompt bool) bool {
	return isTTY && !noPrompt
}

// runExitError returns a non-nil business error when any session failed to
// upload, so the process exits non-zero. A bulk run that prints per-session
// "failed" lines but still exits 0 hides failures from CI (the TC-IMPORT-020
// follow-on gap).
func runExitError(failed, total int) error {
	if failed == 0 {
		return nil
	}
	return output.Conflict(
		fmt.Sprintf("%d of %d session(s) failed to upload", failed, total),
		map[string]interface{}{"failed": failed, "total": total},
	)
}

// dropPlatform returns ids without drop (used to soft-skip hermes under a
// default all-platforms import when materialization fails).
func dropPlatform(ids []conversation.PlatformID, drop conversation.PlatformID) []conversation.PlatformID {
	out := make([]conversation.PlatformID, 0, len(ids))
	for _, p := range ids {
		if p != drop {
			out = append(out, p)
		}
	}
	return out
}

// bridgeHermes wires the Hermes DB bridge into a scan/run command. When hermes
// is in scope and not overridden by --path hermes=, it materializes state.db
// into a temp dir and points customRoots[hermes] at it. Returns a cleanup func
// (always non-nil — defer it), the possibly-filtered platform list (hermes
// dropped on a soft-fail under default all-platforms), and an error (only when
// hermes was named explicitly and materialization failed).
func bridgeHermes(
	cmd *cobra.Command,
	defaultAll bool,
	platformIDs []conversation.PlatformID,
	customRoots map[conversation.PlatformID][]string,
	until string,
) (func(), []conversation.PlatformID, error) {
	cleanup := func() {}
	if !conversation.ShouldBridgeHermes(platformIDs, customRoots) {
		return cleanup, platformIDs, nil
	}
	m, err := conversation.MaterializeHermes(until)
	if err != nil {
		if defaultAll {
			fmt.Fprintf(cmd.ErrOrStderr(), "hermes: skipped (%v)\n", err)
			return cleanup, dropPlatform(platformIDs, conversation.PlatformHermes), nil
		}
		return cleanup, platformIDs, output.IOErr("hermes", "materialize", err)
	}
	if m.SessionCount == 0 {
		// Nothing matched (all in-flight, or --until filtered everything out).
		// Pointing the scanner at an empty dir would trip Service.Scan's generic
		// "directory layout may have changed" drift warning, which is misleading
		// here. Drop hermes cleanly and say why.
		m.Cleanup()
		fmt.Fprintln(cmd.ErrOrStderr(), "hermes: no ended sessions to import")
		return func() {}, dropPlatform(platformIDs, conversation.PlatformHermes), nil
	}
	customRoots[conversation.PlatformHermes] = []string{m.Dir}
	return m.Cleanup, platformIDs, nil
}

// buildScanView converts a ScanReport + filtered items into a scanView.
func buildScanView(rep *conversation.ScanReport, items []conversation.Item) scanView {
	view := scanView{
		NotFound:      map[string]string{},
		DriftWarnings: rep.DriftWarnings,
		SkippedActive: rep.SkippedActive,
	}
	for p, hint := range rep.NotFound {
		view.NotFound[string(p)] = hint
	}
	for _, item := range items {
		date := item.StartedAt
		if date == "" {
			date = item.UpdatedAt
		}
		if len(date) >= 10 {
			date = date[:10]
		}
		view.Items = append(view.Items, scanItemView{
			Platform:  string(item.Platform),
			Path:      item.Path,
			Date:      date,
			Messages:  item.MessageCount,
			ToolCalls: item.ToolCallCount,
			Status:    item.Status,
		})
	}
	view.Groups = groupScanItems(items)
	view.Summary = summarizeScanItems(items)
	return view
}
