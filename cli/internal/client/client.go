package client

import (
	"context"
)

// Client is the EverMe HTTP API surface used by EverCli. All commands
// route through this single interface so tests can substitute a fake
// (internal/httpmock) without monkey-patching net/http.
//
// Each method returns either a *Resp on success or one of {AuthError,
// UpstreamError, NetworkError, *output.CLIError(unclassified)} on failure.
//
// MVP: methods are listed but not implemented. The first wave of tests
// (auth flow) will land alongside the concrete implementation in
// httpClient.
type Client interface {
	// --- Auth ---------------------------------------------------------
	//
	// Me() (GET /auth/me, JWT-only) was retired in the slimming pass.
	// CLI's `auth me` subcommand validates the emk via POST /auth/login
	// instead — see auth.Service.Me. DisconnectAgent was retired with
	// `evercli plugin uninstall`.

	DeviceStart(ctx context.Context, req DeviceStartReq) (*DeviceStartResp, error)
	DeviceToken(ctx context.Context, deviceCode string) (*DeviceTokenResp, error)
	Login(ctx context.Context, apiKey string) (*LoginResp, error)

	// --- Agents -------------------------------------------------------

	ListAgents(ctx context.Context, filter AgentFilter) ([]Agent, error)
	RegisterAgent(ctx context.Context, req RegisterAgentReq) (*RegisterAgentResp, error)
	DisconnectAgent(ctx context.Context, agentID string) error

	// --- Memory / Records --------------------------------------------

	// --- Transport tuning -------------------------------------------

	// SetUserAgent overrides the default User-Agent header. Production
	// wires the build version here so backend audit logs distinguish
	// dev binaries from release builds.
	SetUserAgent(ua string)
}

// DeviceStartReq is the payload for POST /auth/device. The backend requires
// platform; machineFingerprint is optional but recommended.
type DeviceStartReq struct {
	ClientName         string `json:"clientName,omitempty"`
	ClientVersion      string `json:"clientVersion,omitempty"`
	Platform           string `json:"platform"`
	MachineFingerprint string `json:"machineFingerprint,omitempty"`
}

// DeviceStartResp mirrors the backend response.
type DeviceStartResp struct {
	DeviceCode      string `json:"deviceCode"`
	UserCode        string `json:"userCode"`
	VerificationURL string `json:"verificationUrl"`
	ExpiresIn       int    `json:"expiresIn"`
	Interval        int    `json:"interval"`
}

// DeviceTokenReq is the body for POST /auth/token. grantType is required
// by the backend ("device_code" per RFC 8628).
type DeviceTokenReq struct {
	DeviceCode string `json:"deviceCode"`
	GrantType  string `json:"grantType"`
}

// DeviceTokenResp covers both pending and approved poll responses. When
// Status == "pending" only Status + Interval are populated; on approved
// the credential block is filled.
type DeviceTokenResp struct {
	Status       string   `json:"status"`
	APIKey       string   `json:"apiKey,omitempty"`
	APIKeyPrefix string   `json:"apiKeyPrefix,omitempty"`
	AgentToken   string   `json:"agentToken,omitempty"`
	AgentID      string   `json:"agentId,omitempty"`
	IsNewKey     bool     `json:"isNewKey,omitempty"`
	Scopes       []string `json:"scopes,omitempty"`
	Interval     int      `json:"interval,omitempty"`
}

// LoginResp is the result of POST /auth/login. Valid is the backend's
// boolean — we still surface the rest because the envelope-level
// status==0 is the canonical success signal.
type LoginResp struct {
	Valid        bool     `json:"valid"`
	AccountID    string   `json:"accountId"`
	Email        string   `json:"email"`
	APIKeyPrefix string   `json:"apiKeyPrefix"`
	Scopes       []string `json:"scopes"`
}

// (MeResp retired with Client.Me; auth.Service.Me uses Login(emk).)

// AgentFilter narrows POST /agents/list. Both fields are optional; empty
// means "no filter".
type AgentFilter struct {
	Platform           string
	MachineFingerprint string
}

// Agent is one row from POST /agents/list.
// LastActiveAt is a pointer-string in the backend; we surface it as a
// nullable time-encoded string and parse on demand.
type Agent struct {
	ID                 string `json:"id"`
	Platform           string `json:"platform"`
	Name               string `json:"name"`
	ClientVersion      string `json:"clientVersion,omitempty"`
	MachineFingerprint string `json:"machineFingerprint"`
	TokenPrefix        string `json:"tokenPrefix"`
	ConnectionStatus   string `json:"connectionStatus"`
	LastActiveAt       string `json:"lastActiveAt,omitempty"`
	CreatedAt          string `json:"createdAt"`
}

// RegisterAgentReq creates / claims an agent slot. Mirrors backend's
// RegisterAgentRequest: platform/name/machineFingerprint required,
// clientVersion optional. Hostname/OS are NOT accepted — drop them
// from any callsite.
type RegisterAgentReq struct {
	Platform           string `json:"platform"`
	Name               string `json:"name"`
	ClientVersion      string `json:"clientVersion,omitempty"`
	MachineFingerprint string `json:"machineFingerprint"`
}

// RegisterAgentResp returns the freshly minted evt plus identifiers.
// Backend returns sourceId once Stage-5 source creation is wired; CLI
// must tolerate empty.
type RegisterAgentResp struct {
	AgentID     string `json:"agentId"`
	AgentToken  string `json:"agentToken"`
	TokenPrefix string `json:"tokenPrefix"`
	SourceID    string `json:"sourceId,omitempty"`
}
