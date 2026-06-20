package plugin

import (
	"context"
	"fmt"
	"os"
	"sync"

	"evercli/internal/client"
	"evercli/internal/machineid"
	"evercli/internal/output"
)

// defaultMachineFn adapts machineid.Fingerprint to the per-platform
// signature used internally. Kept as a function so tests can swap it via
// SetMachineFingerprintFn.
func defaultMachineFn(p Platform) string { return machineid.Fingerprint(string(p)) }

// Service is the orchestration layer the cmd/plugin package talks to.
// It composes Detector + Writer (via registry) with the EverMe HTTP
// client to drive list/install/uninstall.
type Service struct {
	cli       client.Client
	reg       *registry
	apiURL    string
	machineFn func(Platform) string // injectable for stable fingerprints in tests
}

// NewService returns a Service backed by the default registry. apiURL is
// the EverMe base URL written into MCP config (so the @everme/memory-mcp
// runtime knows where to call).
func NewService(cli client.Client, apiURL string) *Service {
	return &Service{cli: cli, reg: DefaultRegistry(), apiURL: apiURL, machineFn: defaultMachineFn}
}

// NewServiceWithRegistry is the test-friendly variant that lets tests
// substitute the registry (e.g. point at a tmp config path).
func NewServiceWithRegistry(cli client.Client, reg *registry, apiURL string) *Service {
	return &Service{cli: cli, reg: reg, apiURL: apiURL, machineFn: defaultMachineFn}
}

// SetMachineFingerprintFn lets tests pin the fingerprint so EverMe-side
// joins are deterministic.
func (s *Service) SetMachineFingerprintFn(fn func(Platform) string) { s.machineFn = fn }

// SupportedPlatforms is exposed for cmd/plugin --help rendering.
func (s *Service) SupportedPlatforms() []Platform { return s.reg.SupportedPlatforms() }

// ---- List -----------------------------------------------------------

// PlatformInfo is the per-platform shape returned by `plugin list`. It joins
// local detection with the matching cloud-side agent (if any).
type PlatformInfo struct {
	Platform        Platform        `json:"platform"`
	DisplayName     string          `json:"displayName"`
	Installed       bool            `json:"installed"`
	ConfigPath      string          `json:"configPath,omitempty"`
	HasEverMeEntry  bool            `json:"hasEverMeEntry"`
	RegisteredAgent *registeredItem `json:"registeredAgent,omitempty"`

	// DetectError is populated when the detector failed to read or
	// parse the platform's config file (e.g. permissions denied,
	// malformed JSON). Older versions silently turned these into
	// `Installed: false`, which mis-attributed real bugs as "not
	// installed". Frontends / Agents now see the structured cause and
	// can offer a fix instead of guessing.
	DetectError *DetectErrorItem `json:"detectError,omitempty"`
}

type DetectErrorItem struct {
	Type    string `json:"type"`
	Code    int    `json:"code,omitempty"`
	Message string `json:"message"`
	Hint    string `json:"hint,omitempty"`
}

// registeredItem is the agent fields surfaced under data.platforms[].registeredAgent.
// Time-encoded fields stay as backend RFC3339 strings — keeps Web /
// Agent comparisons textual and avoids time-zone reformatting drift.
type registeredItem struct {
	ID               string `json:"id"`
	TokenPrefix      string `json:"tokenPrefix"`
	ConnectionStatus string `json:"connectionStatus,omitempty"`
	CreatedAt        string `json:"createdAt,omitempty"`
	LastActiveAt     string `json:"lastActiveAt,omitempty"`
}

// List runs every detector concurrently and joins each with the cloud
// agent registered for THIS machine on THAT platform. The order in the
// returned slice matches SupportedPlatforms (alphabetical) so output
// is stable.
//
// Cloud-side lookup is scoped to (platform, this-machine fingerprint).
// machineid.Fingerprint mixes the platform string into its hash, so
// each platform on the same physical machine has a distinct fingerprint;
// server-side AgentStore.Upsert enforces uniqueness on (account,
// platform, fingerprint), so the filtered ListAgents returns at most
// one row per call.
//
// Same-account agents on OTHER devices (different fingerprint) are
// intentionally excluded — surfacing them here mis-attributes them to
// the current machine. They belong under a separate `agent list
// --all-devices`-style view, not this command.
//
// ListAgents failure for any one platform does not fail List — local
// detection is still useful offline; the platform just shows up without
// a RegisteredAgent.
func (s *Service) List(ctx context.Context) ([]PlatformInfo, error) {
	platforms := s.reg.SupportedPlatforms()

	type slot struct {
		det    *Detection
		detErr error
		agent  *client.Agent
	}
	results := make([]slot, len(platforms))
	var wg sync.WaitGroup
	wg.Add(len(platforms))
	for i, p := range platforms {
		i, p := i, p
		go func() {
			defer wg.Done()
			det := s.reg.detector(p)
			results[i].det, results[i].detErr = det.Detect(ctx)

			// Per-platform fingerprint-scoped lookup. Server-side
			// uniqueness invariant means ≤1 row. The platform +
			// fingerprint guard is defense-in-depth against a
			// degraded server returning unrelated rows.
			fp := s.machineFn(p)
			agents, lerr := s.cli.ListAgents(ctx, client.AgentFilter{
				Platform:           string(p),
				MachineFingerprint: fp,
			})
			if lerr != nil || len(agents) == 0 {
				return
			}
			a := &agents[0]
			if a.Platform == string(p) && a.MachineFingerprint == fp {
				results[i].agent = a
			}
		}()
	}
	wg.Wait()

	out := make([]PlatformInfo, 0, len(platforms))
	for i, p := range platforms {
		d := results[i].det
		if d == nil {
			displayName := string(p)
			if det := s.reg.detector(p); det != nil {
				displayName = det.DisplayName()
			}
			d = &Detection{Platform: p, DisplayName: displayName}
		}
		info := PlatformInfo{
			Platform:       p,
			DisplayName:    d.DisplayName,
			Installed:      d.Installed,
			ConfigPath:     d.ConfigPath,
			HasEverMeEntry: d.HasEverMeEntry,
		}
		if results[i].detErr != nil {
			ce := output.ClassifyError(results[i].detErr)
			info.DetectError = &DetectErrorItem{
				Type:    string(ce.Type),
				Code:    ce.Code,
				Message: ce.Message,
				Hint:    ce.Hint,
			}
		}
		if a := results[i].agent; a != nil {
			info.RegisteredAgent = &registeredItem{
				ID:               a.ID,
				TokenPrefix:      a.TokenPrefix,
				ConnectionStatus: a.ConnectionStatus,
				CreatedAt:        a.CreatedAt,
				LastActiveAt:     a.LastActiveAt,
			}
		}
		out = append(out, info)
	}
	return out, nil
}

// ---- Install --------------------------------------------------------

// InstallOptions per-platform install knobs.
type InstallOptions struct {
	Force  bool // proceed even when Detector reports not-installed
	DryRun bool // run Plan only; never call backend or mutate config
}

// InstallReport is the aggregate of per-platform outcomes for the public
// install result envelope.
type InstallReport struct {
	Installed []InstallEntry `json:"installed"`
	Skipped   []SkipEntry    `json:"skipped"`
	Failed    []FailedEntry  `json:"failed"`
}

// InstallEntry is one successful install row.
//
// Warnings carries non-fatal post-install observations — currently only
// Verify failures. The Commit happened and the token is in place both
// on disk and on the server; Warnings tells the user (and structured-
// JSON consumers) "the install succeeded but a sanity check tripped,
// run doctor to confirm". Verify failures used to be FailedEntry, but
// that produced state drift: the runtime treated the install as live
// while the report said failed.
type InstallEntry struct {
	Platform    Platform `json:"platform"`
	AgentID     string   `json:"agentId"`
	SourceID    string   `json:"sourceId"`
	TokenPrefix string   `json:"tokenPrefix"`
	ConfigPath  string   `json:"configPath"`
	BackupPath  string   `json:"backupPath,omitempty"`
	Warnings    []string `json:"warnings,omitempty"`
}

// SkipEntry covers --no-prompt + not-detected and similar voluntary
// skips. Reason is a short identifier (Agent-friendly).
type SkipEntry struct {
	Platform Platform `json:"platform"`
	Reason   string   `json:"reason"`
}

// FailedEntry is one failed install row, with the underlying error
// rendered as a CLIError-shaped object. Mirrors importer.runFailErr —
// AI Agents can switch on the same fields across batch operations.
type FailedEntry struct {
	Platform Platform   `json:"platform"`
	Error    failedBody `json:"error"`
}

type failedBody struct {
	Type    output.ErrorType `json:"type"`
	Code    int              `json:"code,omitempty"`
	Message string           `json:"message"`
	Hint    string           `json:"hint,omitempty"`
}

// Install runs the full pipeline for each requested platform serially.
// Token-lifecycle ordering (04-plugin.md §4.6.1):
//
//  1. Detect → optionally skip if not installed and !Force
//  2. Writer.Plan (local pre-check; no backend side effect yet)
//  3. RegisterAgent → fresh evt (rotation invalidates old one)
//  4. Writer.Commit → write fresh evt; on failure, return retry hint
//
// A failure in any single platform is captured in Failed; we always try
// the rest. The caller decides how to surface partial failures (cmd
// returns ok:false when len(Failed) > 0).
func (s *Service) Install(ctx context.Context, platforms []Platform, opts InstallOptions, prompt PromptFn) (*InstallReport, error) {
	if len(platforms) == 0 {
		return nil, output.Invalid("at least one platform is required", "Pass platform names, e.g. `evercli plugin install claude-code`")
	}
	rep := &InstallReport{}
	for _, p := range platforms {
		if !s.reg.Has(p) {
			rep.Failed = append(rep.Failed, FailedEntry{
				Platform: p,
				Error:    failedBody{Type: output.TypeInvalidArgs, Message: fmt.Sprintf("unknown platform %q", p)},
			})
			continue
		}
		s.installOne(ctx, p, opts, prompt, rep)
	}
	return rep, nil
}

// PromptFn is the cmd-supplied confirmation hook for tty interactive
// flows ("Continue anyway?"). Returns (proceed, err). nil means "skip
// the prompt entirely and use the documented default" — Service.Install
// treats that as "don't proceed" for safety, matching --no-prompt.
type PromptFn func(message string) (bool, error)

func (s *Service) installOne(ctx context.Context, p Platform, opts InstallOptions, prompt PromptFn, rep *InstallReport) {
	det := s.reg.detector(p)
	wr := s.reg.writer(p)

	detection, detErr := det.Detect(ctx)
	// Detector errors are real (permissions denied / malformed JSON /
	// unreadable file). The previous code dropped them and let the
	// "not detected" branch handle it, which produced misleading
	// "skipped: not detected" output even when the file was right
	// there but unreadable. Surface the real cause instead.
	if detErr != nil {
		rep.Failed = append(rep.Failed, failedFrom(p, detErr))
		return
	}
	if detection == nil {
		// Defensive: every detector should return at least a partial
		// Detection. If one slipped through (mock?), treat as failed
		// rather than continuing with a nil pointer.
		rep.Failed = append(rep.Failed, failedFrom(p, output.Internal(fmt.Errorf("detector for %s returned nil result", p))))
		return
	}

	if !detection.Installed && !opts.Force {
		// Optionally prompt the user. With --no-prompt (PromptFn=nil)
		// we default to skip to avoid blowing away a config dir we
		// shouldn't be touching.
		proceed := false
		if prompt != nil {
			ok, err := prompt(fmt.Sprintf("%s not detected on this machine. Continue anyway?", det.DisplayName()))
			if err == nil {
				proceed = ok
			}
		}
		if !proceed {
			rep.Skipped = append(rep.Skipped, SkipEntry{Platform: p, Reason: "not detected"})
			return
		}
	}

	// 0. Optional Prepare: side-effecting setup BEFORE token mint
	// (e.g. Codex marketplace add). Failures here MUST NOT consume a
	// /agents call — they're for things like "host CLI missing",
	// "network down for marketplace add", "PyPI install failed". A
	// stranded cloud token from a prep failure would survive across
	// re-runs and bloat the user's agent list. Writers that don't need
	// a prep step skip the interface and this no-ops.
	if pr, ok := wr.(Preparer); ok && !opts.DryRun {
		if err := pr.Prepare(ctx, detection); err != nil {
			rep.Failed = append(rep.Failed, failedFrom(p, err))
			return
		}
	}

	// 1. Plan (local pre-check). Token has NOT been rotated yet.
	plan, err := wr.Plan(ctx, detection.ConfigPath)
	if err != nil {
		rep.Failed = append(rep.Failed, failedFrom(p, err))
		return
	}

	if opts.DryRun {
		rep.Installed = append(rep.Installed, InstallEntry{
			Platform:    p,
			ConfigPath:  plan.ConfigPath,
			BackupPath:  plan.BackupPath,
			AgentID:     "agt_<dry-run>",
			SourceID:    "src_<dry-run>",
			TokenPrefix: "evt_<dry-run>",
		})
		return
	}

	// 2. Backend register: rotates token if agent already exists.
	regResp, err := s.cli.RegisterAgent(ctx, s.buildRegisterReq(p, det.DisplayName()))
	if err != nil {
		rep.Failed = append(rep.Failed, failedFrom(p, err))
		return
	}

	// 3. Commit: write the freshly-minted evt. If this fails, the OLD
	// evt (if any) is already invalidated by step 2 — we can't restore
	// the previous evt. The retry path is "rerun install": same-platform
	// + same-fingerprint upsert on /agents auto-rotates the token, so
	// a stranded server-side token from a failed Commit self-heals on
	// the next install attempt. See H.4 in
	// docs/mcp-codex-hermes-iteration-plan-2026-05-26.md for why V1
	// doesn't restore Client.DisconnectAgent.
	res, err := wr.Commit(ctx, plan, WriteParams{
		AgentID:    regResp.AgentID,
		AgentToken: regResp.AgentToken,
		APIBaseURL: s.apiURL,
	})
	if err != nil {
		// Preserve any specific cause hint the writer's Plan / Commit
		// chain already set (e.g. permissions, "fix the config shape",
		// "another process edited the file") AND append the retry
		// instruction so the user sees both the cause and the
		// recovery path. The retry will re-register (rotate token
		// again) and re-attempt the local write — idempotent on the
		// happy path; idempotent on the bad path with one stranded
		// cloud agent waiting for a manual cleanup.
		retry := "Run `evercli plugin install " + string(p) + "` again — the next attempt auto-rotates the token via /agents upsert. If Commit keeps failing, disconnect the stranded cloud agent from the EverMe web UI and remove the local config entry manually."
		rep.Failed = append(rep.Failed, failedFromWithHint(p, err, retry))
		return
	}

	// 4. Optional Verify: post-commit sanity check (e.g. read back
	// config, host CLI says "registered", etc.). A Verify failure is
	// surfaced as a WARNING on the InstallEntry, not a FailedEntry —
	// at this point the token is already (a) on disk at 0600 and (b)
	// registered on the server. Reporting "failed" while the runtime
	// is live produces state drift: automation consumers ignore the
	// install but the agent works. Warnings communicate "config is in
	// place, please verify with doctor" without lying about install
	// success.
	entry := InstallEntry{
		Platform:    p,
		AgentID:     regResp.AgentID,
		SourceID:    regResp.SourceID,
		TokenPrefix: regResp.TokenPrefix,
		ConfigPath:  res.ConfigPath,
		BackupPath:  res.BackupPath,
	}
	if vr, ok := wr.(Verifier); ok {
		if err := vr.Verify(ctx, res); err != nil {
			ce := output.ClassifyError(err)
			warn := ce.Message
			if ce.Hint != "" {
				warn = warn + " — " + ce.Hint
			}
			warn = warn + ". Run `evercli doctor` to confirm the install is healthy; if it isn't, re-run `evercli plugin install " + string(p) + "` to rotate and reapply."
			entry.Warnings = append(entry.Warnings, warn)
		}
	}
	rep.Installed = append(rep.Installed, entry)
}

func failedFrom(p Platform, err error) FailedEntry {
	return failedFromWithHint(p, err, "")
}

// failedFromWithHint builds a FailedEntry preserving any hint already
// set by the underlying CLIError. extraHint is appended (with a "—
// then" separator) so the user sees both the cause AND the recovery
// path. Passing extraHint by value beats the previous approach of
// mutating ce.Hint via an AsCLIError pointer — that depended on
// ClassifyError happening to return the same struct AsCLIError
// returned, which is brittle.
func failedFromWithHint(p Platform, err error, extraHint string) FailedEntry {
	ce := output.ClassifyError(err)
	hint := ce.Hint
	if extraHint != "" {
		if hint == "" {
			hint = extraHint
		} else {
			hint = hint + " — then " + extraHint
		}
	}
	return FailedEntry{
		Platform: p,
		Error: failedBody{
			Type:    ce.Type,
			Code:    ce.Code,
			Message: ce.Message,
			Hint:    hint,
		},
	}
}

// (Service.Uninstall / findCloudAgent / classifyDisconnectErr and the
// associated UninstallResult / UninstallOptions / DisconnectErrorDetail
// types were retired in the slimming pass. The plugin lifecycle is now
// "install-only"; users disconnect agents from the EverMe web UI and
// remove local MCP entries by hand if needed. Writer.Remove is also
// gone — see types.go and the per-writer files.)

// buildRegisterReq composes the RegisterAgent request body for Install.
// The display label comes from the live Detector — `evercli plugin
// register` (which historically supplied a synthesised fallback label
// for hosts without a Detector) was retired in V1, so this helper now
// has a single caller.
func (s *Service) buildRegisterReq(p Platform, displayName string) client.RegisterAgentReq {
	hostname, _ := os.Hostname()
	return client.RegisterAgentReq{
		Platform:           string(p),
		Name:               displayName + " @ " + shortHost(hostname),
		MachineFingerprint: s.machineFn(p),
		ClientVersion:      "evercli/" + osTag(),
	}
}

// (Service.Register / RegisterResult / displayFallback were retired in V1
// alongside the `evercli plugin register` cobra command — see
// docs/mcp-codex-hermes-iteration-plan-2026-05-26.md §D.3. The backend
// /agents endpoint stays; Install drives it through the path above.)

// osTag is a short string ("darwin"/"linux"/"windows") for the backend's
// telemetry. Centralised here so all RegisterAgent calls agree.
func osTag() string {
	return runtimeGOOS()
}

// Uninstall orchestrates the local cleanup of EverMe configurations across the requested
// platforms. It utilizes the Remover interface to safely strip configurations.
func (s *Service) Uninstall(ctx context.Context, platforms []Platform) error {
	if len(platforms) == 0 {
		return output.Invalid("at least one platform is required (or use --all)", "")
	}

	for _, p := range platforms {
		if !s.reg.Has(p) {
			fmt.Printf("✗ %s: unknown platform\n", p)
			continue
		}

		wr := s.reg.writer(p)
		remover, ok := wr.(Remover)
		if !ok {
			fmt.Printf("— %s: uninstall not yet supported for this platform format\n", p)
			continue
		}

		det := s.reg.detector(p)
		detection, err := det.Detect(ctx)
		if err != nil || detection == nil || detection.ConfigPath == "" {
			fmt.Printf("— %s: could not detect config path\n", p)
			continue
		}

		modified, err := remover.Remove(ctx, detection.ConfigPath)
		if err != nil {
			fmt.Printf("✗ %s failed to uninstall: %v\n", p, err)
		} else if modified {
			fmt.Printf("✓ %s: successfully removed EverMe configuration from %s\n", p, detection.ConfigPath)
		} else {
			fmt.Printf("— %s: no EverMe configuration found in %s\n", p, detection.ConfigPath)
		}
	}
	
	fmt.Println("\nNote: Local configurations removed. Please ensure you disconnect the agents from the EverMe Web UI to revoke server-side tokens.")
	return nil
}