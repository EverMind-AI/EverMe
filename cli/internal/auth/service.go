package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"evercli/internal/client"
	"evercli/internal/core"
	"evercli/internal/credential"
	"evercli/internal/logger"
	"evercli/internal/machineid"
	"evercli/internal/output"
	"evercli/internal/validate"
)

// Service is the auth orchestration layer. It owns the local cache files
// (account.json, device-session.json) and the credential.Provider; it
// composes calls into client.Client to drive the four login flavors plus
// logout/status/me.
//
// All exported methods are safe to call concurrently — but in practice
// there is only ever one caller (the cmd layer for one process).
type Service struct {
	cli   client.Client
	cred  credential.Provider
	paths *core.Paths

	// nowFn is injectable so polling tests don't have to wait real time.
	nowFn func() time.Time
}

// NewService constructs a Service with the given dependencies. paths is
// authoritative for where account/session files live.
func NewService(cli client.Client, cred credential.Provider, paths *core.Paths) *Service {
	return &Service{
		cli:   cli,
		cred:  cred,
		paths: paths,
		nowFn: time.Now,
	}
}

// LoginOptions selects which login flavor to run. Exactly one of
// {APIKey, NoWait, DeviceCode, default} should be active per call:
//
//   - APIKey != "":     one-shot validate-and-store via POST /auth/login
//   - NoWait == true:   start Device Flow, persist session, return immediately
//   - DeviceCode != "": single poll resume (no DeviceStart)
//   - otherwise:        blocking Device Flow (DeviceStart + poll loop until approved/expired)
//
// NoOpen was retired in the slimming pass — the CLI prints the
// verificationUrl for the user to copy / paste; auto-opening a browser
// was never wired in either layer, so the flag was a documentation-only
// promise. Reintroduce alongside an actual exec.Command("open" / "xdg-
// open" / start) implementation when the UX warrants it.
type LoginOptions struct {
	APIKey     string
	NoWait     bool
	DeviceCode string

	// ClientName / ClientVersion are passed to /auth/device so the
	// backend can attribute Device Flow sessions. Defaults to "EverCli"
	// / "dev" when zero-valued.
	ClientName    string
	ClientVersion string

	// OnDeviceStarted, if set, is invoked once in the blocking flow right
	// after DeviceStart succeeds and before the silent poll loop begins.
	// The cmd layer wires this to a stderr writer so humans see the
	// verificationUrl + userCode they need to approve; without it the
	// blocking flow looks like a hang. Not invoked in --no-wait or
	// --device-code resume flows (those surface the URL via stdout
	// envelope themselves).
	OnDeviceStarted func(verificationURL, userCode string, expiresInSec int)
}

// LoginResult carries everything the cmd layer might want to render:
//   - approved → {accountId, email, apiKeyPrefix, isNewKey, scopes}
//   - pending  → {status, userCode, verificationUrl, expiresInSec, resumeCommand}
type LoginResult struct {
	Status string `json:"status"` // "approved" | "pending"

	// approved fields
	AccountID    string   `json:"accountId,omitempty"`
	Email        string   `json:"email,omitempty"`
	APIKeyPrefix string   `json:"apiKeyPrefix,omitempty"`
	IsNewKey     bool     `json:"isNewKey,omitempty"`
	Scopes       []string `json:"scopes,omitempty"`

	// pending fields
	UserCode        string `json:"userCode,omitempty"`
	VerificationURL string `json:"verificationUrl,omitempty"`
	ExpiresInSec    int    `json:"expiresInSec,omitempty"`
	ResumeCommand   string `json:"resumeCommand,omitempty"`
	DeviceCode      string `json:"deviceCode,omitempty"` // returned when --no-wait so the cmd layer can also persist it via env etc.
}

// Login dispatches to the right flavor based on options.
func (s *Service) Login(ctx context.Context, opts LoginOptions) (*LoginResult, error) {
	switch {
	case opts.APIKey != "":
		return s.loginAPIKey(ctx, opts.APIKey)
	case opts.DeviceCode != "":
		return s.loginDeviceResume(ctx, opts.DeviceCode)
	case opts.NoWait:
		return s.loginDeviceStartOnly(ctx, opts)
	default:
		return s.loginDeviceBlocking(ctx, opts)
	}
}

// ---- flavor implementations -----------------------------------------

func (s *Service) loginAPIKey(ctx context.Context, key string) (*LoginResult, error) {
	if err := validate.APIKey(key); err != nil {
		return nil, err
	}
	resp, err := s.cli.Login(ctx, key)
	if err != nil {
		return nil, err
	}
	if err := s.cred.Set(ctx, credential.APIKey(), key); err != nil {
		return nil, output.IOErr("credential", "set", err)
	}
	if err := s.persistAccount(resp); err != nil {
		// Rollback the credential we just stored so the user doesn't
		// end up with "emk on disk but no account.json".
		if delErr := s.cred.Delete(ctx, credential.APIKey()); delErr != nil && !errors.Is(delErr, credential.ErrNotFound) && !errors.Is(delErr, credential.ErrReadOnly) {
			logger.L().Warnw("loginAPIKey rollback delete failed",
				"persistErr", err.Error(),
				"deleteErr", delErr.Error(),
			)
		}
		return nil, err
	}
	// Register self as a platform="evercli" agent so uploads (presign +
	// create-source) have an evt-bound token; emk no longer accepted on
	// write routes after the source/record merge. Failure here is logged
	// but doesn't fail the login itself — Status / Me still work.
	if err := s.ensureSelfAgent(ctx); err != nil {
		logger.L().Warnw("loginAPIKey: ensureSelfAgent failed (uploads will require manual re-auth)",
			"err", err.Error(),
		)
	}
	return &LoginResult{
		Status:       "approved",
		AccountID:    resp.AccountID,
		Email:        resp.Email,
		APIKeyPrefix: resp.APIKeyPrefix,
		IsNewKey:     false,
		Scopes:       resp.Scopes,
	}, nil
}

// ensureSelfAgent registers (or re-registers) this EverCli installation
// as a platform="evercli" agent and caches the evt locally. The backend
// upserts on (account, platform, machine_fingerprint), so this is safe
// to call on every login — it rotates the token but doesn't create
// duplicate rows.
func (s *Service) ensureSelfAgent(ctx context.Context) error {
	const platform = "evercli"
	resp, err := s.cli.RegisterAgent(ctx, client.RegisterAgentReq{
		Platform:           platform,
		Name:               "EverCli",
		ClientVersion:      "dev",
		MachineFingerprint: machineid.Fingerprint(platform),
	})
	if err != nil {
		return fmt.Errorf("register self agent: %w", err)
	}
	if err := s.cred.Set(ctx, credential.AgentToken(), resp.AgentToken); err != nil {
		return fmt.Errorf("persist evt: %w", err)
	}
	return nil
}

func (s *Service) loginDeviceStartOnly(ctx context.Context, opts LoginOptions) (*LoginResult, error) {
	resp, err := s.cli.DeviceStart(ctx, deviceStartReq(opts))
	if err != nil {
		return nil, err
	}
	now := s.nowFn()
	session := &DeviceSession{
		DeviceCode:      resp.DeviceCode,
		UserCode:        resp.UserCode,
		VerificationURL: resp.VerificationURL,
		ExpiresAt:       now.Add(time.Duration(resp.ExpiresIn) * time.Second),
		CreatedAt:       now,
		Interval:        resp.Interval,
	}
	if err := SaveDeviceSession(s.paths.DeviceSessionFile(), session); err != nil {
		return nil, output.IOErr(s.paths.DeviceSessionFile(), "save-session", err)
	}
	return &LoginResult{
		Status:          "pending",
		UserCode:        resp.UserCode,
		VerificationURL: resp.VerificationURL,
		ExpiresInSec:    resp.ExpiresIn,
		ResumeCommand:   fmt.Sprintf("evercli auth login --device-code %s --format json", resp.DeviceCode),
		DeviceCode:      resp.DeviceCode,
	}, nil
}

// loginDeviceResume runs a single DeviceToken poll. On "pending" we
// return ok+pending status (Agent decides whether to keep waiting); on
// "approved" we complete the post-approval flow; on terminal failure
// (expired/etc.) we return a TypeAuth CLIError so cmd surfaces exit 3.
func (s *Service) loginDeviceResume(ctx context.Context, deviceCode string) (*LoginResult, error) {
	resp, err := s.cli.DeviceToken(ctx, deviceCode)
	if err != nil {
		// Only nuke the session for TERMINAL classifications. The old
		// behaviour killed the session on any error — including
		// transient network blips and 5xx — which forced the user to
		// restart the Device Flow when retrying would have sufficed.
		// Auth-typed errors (deviceCode revoked / not found) are
		// genuinely terminal; everything else gets a retry budget.
		if ce, ok := err.(*output.CLIError); ok && ce.Type == output.TypeAuth {
			s.bestEffortDeleteSession("token-error-auth")
		}
		return nil, err
	}
	switch resp.Status {
	case "pending":
		return &LoginResult{Status: "pending"}, nil
	case "approved":
		s.bestEffortDeleteSession("approved")
		return s.completeApproved(ctx, resp)
	case "expired":
		s.bestEffortDeleteSession("expired")
		return nil, output.AuthErr("device code expired", "Run `evercli auth login --no-wait` again to get a fresh code", "")
	default:
		return nil, output.AuthErr(fmt.Sprintf("device token returned unexpected status %q", resp.Status), "", "")
	}
}

// bestEffortDeleteSession removes the device-session file, logging any
// non-NotFound failure at warn level so operators have a breadcrumb for
// stuck-session situations. Never returns an error — the surrounding
// auth result is the user-visible signal.
func (s *Service) bestEffortDeleteSession(reason string) {
	if err := DeleteDeviceSession(s.paths.DeviceSessionFile()); err != nil {
		logger.L().Warnw("delete device-session failed",
			"reason", reason,
			"path", s.paths.DeviceSessionFile(),
			"err", err.Error(),
		)
	}
}

// loginDeviceBlocking runs DeviceStart, then polls DeviceToken every
// resp.Interval seconds until approved or the server-issued deadline
// passes. Honors ctx cancellation throughout.
//
// We extend ctx beyond --timeout to match the server's expiresIn so the
// global 60s default doesn't kill a flow that legitimately waits for the
// user to click in their browser.
func (s *Service) loginDeviceBlocking(ctx context.Context, opts LoginOptions) (*LoginResult, error) {
	// Drop any stale --no-wait session left from a previous run so the
	// blocking flow doesn't accidentally inherit a dead deviceCode if a
	// later resume command attempts to read this file.
	s.bestEffortDeleteSession("blocking-start")
	start, err := s.cli.DeviceStart(ctx, deviceStartReq(opts))
	if err != nil {
		return nil, err
	}
	if opts.OnDeviceStarted != nil {
		opts.OnDeviceStarted(start.VerificationURL, start.UserCode, start.ExpiresIn)
	}

	deadline := s.nowFn().Add(time.Duration(start.ExpiresIn) * time.Second)
	pollCtx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()

	interval := time.Duration(start.Interval) * time.Second
	if interval <= 0 {
		interval = 5 * time.Second
	}

	for {
		// Single poll per iteration. We DO NOT sleep before the first
		// poll — gives Agent-driven flows where the user has already
		// approved by the time we get here a chance to short-circuit.
		// Bound each poll to 2 × interval so a single dead network
		// connection can't burn the entire expiresIn deadline blocked
		// in net/http.Do.
		pollOnce, cancelPoll := context.WithTimeout(pollCtx, 2*interval)
		token, err := s.cli.DeviceToken(pollOnce, start.DeviceCode)
		cancelPoll()
		if err != nil {
			// Any network/auth error during polling is terminal — let
			// the cmd layer print it. Don't delete the session because
			// the cmd layer didn't write one (blocking mode).
			return nil, err
		}
		switch token.Status {
		case "approved":
			return s.completeApproved(pollCtx, token)
		case "pending":
			// fallthrough to sleep
		case "expired":
			return nil, output.AuthErr("device code expired before authorization", "Re-run `evercli auth login`", "")
		default:
			return nil, output.AuthErr(fmt.Sprintf("device token returned unexpected status %q", token.Status), "", "")
		}

		// time.NewTimer + Stop() so cancelled polls don't leak timers
		// onto the runtime's heap (an issue with naive time.After in
		// long-running blocking flows).
		t := time.NewTimer(interval)
		select {
		case <-pollCtx.Done():
			t.Stop()
			if errors.Is(pollCtx.Err(), context.DeadlineExceeded) {
				return nil, output.AuthErr(
					fmt.Sprintf("authorization for code %s timed out", start.UserCode),
					"Re-run `evercli auth login`", "")
			}
			return nil, pollCtx.Err()
		case <-t.C:
		}
	}
}

// completeApproved is the shared post-approval path: store emk, throw
// away evt_evercli, fetch full account profile, persist account.json.
//
// Rollback: if either the post-store Login or persistAccount call
// fails we must NOT leave an emk on disk that can't be paired with an
// account.json — the user would otherwise see a "logged in but no
// profile" state every doctor run. We delete the freshly-set
// credential best-effort so the next `auth login` starts clean.
func (s *Service) completeApproved(ctx context.Context, token *client.DeviceTokenResp) (*LoginResult, error) {
	if token.APIKey == "" {
		return nil, output.Internal(fmt.Errorf("approved response missing apiKey"))
	}
	if err := s.cred.Set(ctx, credential.APIKey(), token.APIKey); err != nil {
		return nil, output.IOErr("credential", "set", err)
	}

	// /auth/login with the freshly-stored emk to get accountId/email.
	// Could re-use scopes from token but Login is the canonical fetch.
	loginResp, err := s.cli.Login(ctx, token.APIKey)
	if err != nil {
		_ = s.cred.Delete(ctx, credential.APIKey())
		return nil, err
	}
	if err := s.persistAccount(loginResp); err != nil {
		_ = s.cred.Delete(ctx, credential.APIKey())
		return nil, err
	}
	// Self-register so the upload path has an evt — see loginAPIKey for rationale.
	if err := s.ensureSelfAgent(ctx); err != nil {
		logger.L().Warnw("completeApproved: ensureSelfAgent failed (uploads will require manual re-auth)",
			"err", err.Error(),
		)
	}

	return &LoginResult{
		Status:       "approved",
		AccountID:    loginResp.AccountID,
		Email:        loginResp.Email,
		APIKeyPrefix: loginResp.APIKeyPrefix,
		IsNewKey:     token.IsNewKey,
		Scopes:       loginResp.Scopes,
	}, nil
}

func deviceStartReq(opts LoginOptions) client.DeviceStartReq {
	name := opts.ClientName
	if name == "" {
		name = "EverCli"
	}
	ver := opts.ClientVersion
	if ver == "" {
		ver = "dev"
	}
	const platform = "evercli"
	return client.DeviceStartReq{
		ClientName:         name,
		ClientVersion:      ver,
		Platform:           platform,
		MachineFingerprint: machineid.Fingerprint(platform),
	}
}

func (s *Service) persistAccount(resp *client.LoginResp) error {
	now := s.nowFn().UTC()
	a := &Account{
		AccountID:    resp.AccountID,
		Email:        resp.Email,
		APIKeyPrefix: resp.APIKeyPrefix,
		Scopes:       resp.Scopes,
		RefreshedAt:  now,
	}
	if err := SaveAccount(s.paths.AccountFile(), a); err != nil {
		return output.IOErr(s.paths.AccountFile(), "save-account", err)
	}
	return nil
}

// ---- Logout ---------------------------------------------------------

// Logout clears all three local artifacts (credential entry, account
// cache, device session). It does NOT call any backend revoke endpoint;
// users can keep using the same emk on other machines (see §3.5).
//
// EnvProvider returns ErrReadOnly here — the credential is supplied via
// EVERCLI_API_KEY and the env var has to be unset to actually log out.
// We translate that into an actionable hint rather than the generic
// "delete failed on credential" IO error users would otherwise see.
func (s *Service) Logout(ctx context.Context) error {
	err := s.cred.Delete(ctx, credential.APIKey())
	switch {
	case err == nil:
	case errors.Is(err, credential.ErrNotFound):
		// Already logged out as far as the credential backend is
		// concerned; account/session files may still need cleaning.
	case errors.Is(err, credential.ErrReadOnly):
		return output.AuthErr(
			"cannot log out while EVERCLI_API_KEY is set",
			"Unset EVERCLI_API_KEY in your shell, then run `evercli auth logout` again",
			"",
		)
	default:
		return output.IOErr("credential", "delete", err)
	}
	// Best-effort agent-token cleanup — not all backends keep it (e.g.
	// EnvProvider only stores emk). Missing is fine; surface other errors.
	if err := s.cred.Delete(ctx, credential.AgentToken()); err != nil &&
		!errors.Is(err, credential.ErrNotFound) && !errors.Is(err, credential.ErrReadOnly) {
		return output.IOErr("credential", "delete-agent-token", err)
	}
	if err := DeleteAccount(s.paths.AccountFile()); err != nil {
		return output.IOErr(s.paths.AccountFile(), "delete-account", err)
	}
	if err := DeleteDeviceSession(s.paths.DeviceSessionFile()); err != nil {
		return output.IOErr(s.paths.DeviceSessionFile(), "delete-session", err)
	}
	return nil
}

// ---- Status / Me ---------------------------------------------------

// Status reads the locally cached account profile. Does NOT hit the
// network — that's the documented auth status contract AI Agents rely
// on for fast, idempotent "are we logged in" probes. Returns a
// TypeNotLoggedIn CLIError when the credential
// entry is missing — even if the cache file happens to exist, no emk
// means not logged in.
//
// Cache miss / corruption surface as TypeAuth errors with a clear
// hint pointing at `evercli auth me`. The previous implementation
// silently fell back to Me() (network round-trip) here; that broke
// the no-network contract and made offline `auth status` block for
// the full --timeout window with no breadcrumb.
func (s *Service) Status(ctx context.Context) (*Account, error) {
	if _, err := s.cred.Get(ctx, credential.APIKey()); err != nil {
		if errors.Is(err, credential.ErrNotFound) {
			return nil, output.NotLoggedIn()
		}
		return nil, output.IOErr("credential", "get", err)
	}
	cached, err := LoadAccount(s.paths.AccountFile())
	if err != nil {
		return nil, output.AuthErr(
			"local account cache is unreadable",
			"Run `evercli auth me` to refresh the cache from the backend",
			"",
		)
	}
	if cached == nil {
		return nil, output.AuthErr(
			"local account cache is missing",
			"Run `evercli auth me` to fetch the account profile from the backend",
			"",
		)
	}
	return cached, nil
}

// Me validates emk against the backend, refreshes the cache, and returns
// the up-to-date Account.
//
// Me uses POST /auth/login with the stored emk in the body — the canonical
// "validate this key" endpoint available to MemAuth callers.
//
// If the backend reports the emk is invalid / revoked the underlying
// CLIError of TypeAuth surfaces directly.
func (s *Service) Me(ctx context.Context) (*Account, error) {
	emk, err := s.cred.Get(ctx, credential.APIKey())
	if err != nil {
		if errors.Is(err, credential.ErrNotFound) {
			return nil, output.NotLoggedIn()
		}
		return nil, output.IOErr("credential", "get", err)
	}
	resp, err := s.cli.Login(ctx, emk)
	if err != nil {
		return nil, err
	}
	a := &Account{
		AccountID:    resp.AccountID,
		Email:        resp.Email,
		APIKeyPrefix: resp.APIKeyPrefix,
		Scopes:       resp.Scopes,
		RefreshedAt:  s.nowFn().UTC(),
	}
	// Best-effort agent count refresh. Failure here doesn't fail Me —
	// agentCount is informational and stale-tolerant — but we DO want
	// the breadcrumb in the log so a doctor / debug bundle picks up
	// scope-drift situations (e.g. emk lost mem:read). Project rule
	// "no fake fallbacks": never silently zero the field on error.
	if agents, listErr := s.cli.ListAgents(ctx, client.AgentFilter{}); listErr == nil {
		a.AgentCount = len(agents)
	} else {
		logger.L().Warnw("listAgents failed during /auth/me refresh; agentCount left unset",
			"err", listErr.Error(),
			"apiKeyPrefix", resp.APIKeyPrefix,
		)
	}
	if err := SaveAccount(s.paths.AccountFile(), a); err != nil {
		return nil, output.IOErr(s.paths.AccountFile(), "save-account", err)
	}
	return a, nil
}
