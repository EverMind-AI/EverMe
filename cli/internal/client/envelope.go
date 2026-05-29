package client

import (
	"encoding/json"
)

// backendEnvelope is the response shape EverMe wraps every JSON response in.
//
//	{ "error": "ErrFooBar", "requestId": "req-123", "status": 30202, "result": null }
//
// `status == 0` means success; anything else is the upstream errno
// (3xxxx auth, 4xxxx record, 5xxxx infra). We decode into json.RawMessage
// so the per-method response struct can be unmarshaled separately —
// avoids paying the cost of double-decoding when status != 0.
type backendEnvelope struct {
	Error     string          `json:"error,omitempty"`
	RequestID string          `json:"requestId,omitempty"`
	Status    int             `json:"status"`
	Result    json.RawMessage `json:"result,omitempty"`
}

// isAuthErrno classifies a backend errno as belonging to the auth space.
//
// The auth space is 30000-30399:
//   - 300XX generic auth (Unauthorized, Forbidden, TokenInvalid, ...)
//   - 301XX Device Flow
//   - 302XX emk / api_key
//   - 303XX evt / agent (AgentTokenInvalid, AgentDisconnected, ScopeInsufficient)
//
// Two carve-outs route to other buckets:
//   - 30005 (JWKS unavailable) → TypeUpstream — auth service down, not the user's auth state.
//   - 30104 (slow-down)        → TypeRateLimit — RFC 8628 polling cadence signal.
//
// Keep this mapping in sync with the public CLI error taxonomy.
func isAuthErrno(code int) bool {
	if code < 30000 || code >= 30400 {
		return false
	}
	switch code {
	case 30005, 30104:
		return false
	}
	return true
}

// isRateLimitErrno picks out 30104 (Device Flow slow-down) and any other
// future rate-limit-shaped errno. HTTP 429 is handled separately at the
// transport layer.
func isRateLimitErrno(code int) bool { return code == 30104 }
