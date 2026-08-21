// Package plugin manages the EverMe MCP plugin lifecycle on local AI
// Agents (Claude Code, OpenClaw, ...). It owns three pieces:
//
//   - Detector: probes the local filesystem to figure out whether a
//     given Agent is installed and whether evercli has previously
//     wired itself in.
//   - Writer:   atomically inserts / removes the everme-memory entry
//     in the Agent's MCP config (with .bak rotation).
//   - Service:  orchestrates Detector + Writer + the EverMe backend
//     (POST /agents, POST /agents/disconnect) for the cmd layer.
//
// New platforms are added by registering a Detector + Writer pair in
// registry.go — no other code change required.
package plugin

import (
	"context"
	"evercli/internal/output"
)

// Platform is a stable enum-like string identifying an Agent. Values
// here are part of the AI-Agent ABI (used as `--platform` arg and in
// `data.platforms[].platform`).
type Platform string

const (
	PlatformClaudeCode    Platform = "claude-code"
	PlatformOpenClaw      Platform = "openclaw"
	PlatformCursor        Platform = "cursor"
	PlatformClaudeDesktop Platform = "claude-desktop"
	PlatformCodex         Platform = "codex"
	PlatformHermes        Platform = "hermes"
	PlatformDevin         Platform = "devin"
	PlatformWorkBuddy     Platform = "workbuddy"
	PlatformOpenCode      Platform = "opencode"
	PlatformKimiCode      Platform = "kimicode"
	PlatformRaven         Platform = "raven"
	PlatformDSH           Platform = "dsh"
)

// Detection is the result of inspecting the local filesystem for one
// platform. It is purely declarative — Detect never mutates anything.
type Detection struct {
	Platform       Platform `json:"platform"`
	DisplayName    string   `json:"displayName"`
	Installed      bool     `json:"installed"`
	ConfigPath     string   `json:"configPath,omitempty"`
	ConfigExists   bool     `json:"configExists"`
	HasEverMeEntry bool     `json:"hasEverMeEntry"`
}

// Detector probes local state for one platform. Implementations must be
// safe to call concurrently; we run them in parallel from Service.List.
type Detector interface {
	Platform() Platform
	DisplayName() string
	Detect(ctx context.Context) (*Detection, error)
}

// WritePlan is the dry-run output of Writer.Plan. It captures everything
// needed to do the actual mutation in Commit, plus diagnostic info for
// `--dry-run`. No backend calls have been made at Plan time, so callers
// can abort here without leaving stale tokens behind.
type WritePlan struct {
	Platform     Platform
	ConfigPath   string
	BackupPath   string // populated if Commit will create a backup
	WillCreate   bool   // config file does not yet exist
	WillReplace  bool   // an everme-memory entry already exists
	PreviewEntry map[string]interface{}

	// SnapshotModTime / SnapshotSize are the (mtime, size) read at
	// Plan time. Commit re-reads them and refuses to overwrite if
	// either has changed: if Claude Code or another evercli wrote
	// between Plan and Commit we abort instead of clobbering. Zero
	// values mean "file did not exist at Plan time" — Commit then
	// rejects when it finds the file has appeared (concurrent-create).
	SnapshotModTime int64 // unix nanoseconds
	SnapshotSize    int64

	auxiliaryFiles []fileSnapshot
}

// WriteParams carries the data Commit needs to materialize the entry —
// most notably the freshly-minted evt token from the backend.
type WriteParams struct {
	AgentID    string
	AgentToken string // evt_*** plaintext; never logged
	APIBaseURL string
}

// WriteResult mirrors the Plan but post-Commit. Used by the cmd layer to
// fill the JSON envelope.
type WriteResult struct {
	Platform      Platform `json:"platform"`
	ConfigPath    string   `json:"configPath"`
	BackupPath    string   `json:"backupPath,omitempty"`
	WroteNewEntry bool     `json:"wroteNewEntry"`

	// NextSteps are required manual follow-ups the user must perform after
	// a successful Commit (distinct from Warnings, which flag a tripped
	// sanity check). Kimi Code uses this for the TUI `/plugins install`
	// registration it cannot do headlessly. Empty for hosts that finish
	// entirely within Commit.
	NextSteps []string `json:"nextSteps,omitempty"`
}

// RemoveResult describes local cleanup. Removal is idempotent: a missing
// config or missing EverMe-owned entry is a successful no-op.
type RemoveResult struct {
	Platform   Platform `json:"platform"`
	ConfigPath string   `json:"configPath"`
	BackupPath string   `json:"backupPath,omitempty"`
	Removed    bool     `json:"removed"`
}

// Writer mutates the local MCP config. The Plan / Commit split lets
// install run a local pre-flight before triggering the backend rotate
// (which immediately invalidates the old evt) — see 04-plugin.md §4.6.1.
type Writer interface {
	Platform() Platform

	// Plan inspects the target ConfigPath and verifies it can be
	// modified. Returns a WritePlan that must be passed to Commit
	// unchanged. No on-disk side effects beyond the lockfile, if any.
	Plan(ctx context.Context, configPath string) (*WritePlan, error)

	// Commit applies the plan: backup → atomic rewrite. If WriteParams
	// includes a fresh AgentToken, callers must NOT call Commit
	// without first having ensured Plan succeeded — once the token is
	// minted, only writing it (or surfacing an error) is safe.
	Commit(ctx context.Context, plan *WritePlan, params WriteParams) (*WriteResult, error)
}

// Remover is implemented by writers that can remove only EverMe-owned
// content while preserving the host's other configuration.
type Remover interface {
	Remove(ctx context.Context, configPath string) (*RemoveResult, error)
}

// UninstallAdvisor lets a writer report host-specific cleanup that cannot be
// performed safely by evercli. Kimi Code's managed plugin registry is owned by
// the host TUI, so local staging cleanup succeeds while the user still needs
// to unregister the entry there.
type UninstallAdvisor interface {
	UninstallNextSteps() []string
}

type UninstallOptions struct{ KeepAgent bool }

type DisconnectErrorDetail struct {
	Type    output.ErrorType `json:"type"`
	Code    int              `json:"code,omitempty"`
	Message string           `json:"message"`
	Hint    string           `json:"hint,omitempty"`
	AgentID string           `json:"agentId,omitempty"`
}

type UninstallResult struct {
	Platform          Platform `json:"platform"`
	Removed           bool     `json:"removed"`
	AgentDisconnected bool     `json:"agentDisconnected"`
	// NoMatchingCloudAgent is true when no cloud agent carried this
	// machine's fingerprint for the platform, so nothing was
	// disconnected. Only an exact fingerprint match is ever revoked —
	// disconnecting anything else risks killing another machine's
	// agent. A matching NextSteps entry points at the web UI fallback.
	NoMatchingCloudAgent bool                   `json:"noMatchingCloudAgent,omitempty"`
	ConfigPath           string                 `json:"configPath,omitempty"`
	BackupPath           string                 `json:"backupPath,omitempty"`
	DisconnectError      *DisconnectErrorDetail `json:"disconnectError,omitempty"`
	LocalDetectError     *DetectErrorItem       `json:"localDetectError,omitempty"`
	NextSteps            []string               `json:"nextSteps,omitempty"`
}

// Preparer is an optional Writer extension for hosts that need a
// side-effecting setup step BEFORE the backend mints a fresh token.
// Service.installOne calls Prepare immediately after Detect and before
// Plan / RegisterAgent — so any failure here surfaces without producing
// a token that would then dangle on the server.
//
// Use cases:
//   - Codex: register the EverMe marketplace via
//     `codex plugin marketplace add`. Without this happening before
//     the token is minted, a marketplace failure (network, missing CLI)
//     would leave a stranded cloud agent.
//   - Hermes: the native MemoryProvider is installed by Commit (embedded
//     python written to $HERMES_HOME/plugins/everme/), not Preparer —
//     there is no out-of-band registration step to run before token mint.
//
// Plan runs after Prepare, so Plan's TOCTOU snapshot already reflects
// any side effects Prepare introduced (e.g. the marketplace section
// appearing in ~/.codex/config.toml). Writers that don't need a prep
// step simply omit this interface — Service ignores the absence.
type Preparer interface {
	Prepare(ctx context.Context, detection *Detection) error
}

// Verifier is an optional Writer extension for hosts where a successful
// Commit doesn't fully prove the install will work at runtime (e.g.
// the host caches config and needs a restart, or there's a separate
// permission gate). Service.installOne calls Verify after Commit; a
// Verify failure appends a human-readable warning to the resulting
// InstallEntry.Warnings field and the entry stays in InstallReport
// .Installed (it does NOT become a FailedEntry). Rationale: the token
// is already on disk and on the server by the time Verify runs, so
// the install IS effectively live; reporting it as Failed produces
// state drift with the runtime. No token rollback is attempted —
// re-running install rotates the token idempotently if the user
// decides to retry.
//
// Writers that have no post-commit check simply omit this interface.
type Verifier interface {
	Verify(ctx context.Context, result *WriteResult) error
}
