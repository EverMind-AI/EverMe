package output

import (
	"context"
	"errors"
	"fmt"
)

// ErrorType is the AI-Agent-facing error taxonomy. Values are part of the
// stable ABI (docs/contracts.md) — adding a new type is
// a minor change, renaming or removing one is a breaking change.
type ErrorType string

const (
	TypeInvalidArgs       ErrorType = "invalid_args"
	TypeNotLoggedIn       ErrorType = "not_logged_in"
	TypeAuth              ErrorType = "auth"
	TypeNetwork           ErrorType = "network"
	TypeUpstream          ErrorType = "upstream"
	TypeConflict          ErrorType = "conflict"
	TypeNotFound          ErrorType = "not_found"
	TypeRateLimit         ErrorType = "rate_limit"
	TypePermission        ErrorType = "permission"
	TypePluginNotDetected ErrorType = "plugin_not_detected"
	TypeIO                ErrorType = "io"
	TypeCancelled         ErrorType = "cancelled"
	TypeInternal          ErrorType = "internal"
)

// ExitCode returns the canonical process exit code for this error type.
// Source of truth for the type→exit mapping; ClassifyError calls into this
// once an error has been bucketed.
func (t ErrorType) ExitCode() ExitCode {
	switch t {
	case TypeInvalidArgs:
		return ExitValidation
	case TypeNotLoggedIn, TypeAuth:
		return ExitAuth
	case TypeNetwork:
		return ExitNetwork
	case TypeCancelled:
		return ExitCancelled
	case TypeIO, TypeInternal:
		return ExitInternal
	default:
		// upstream / conflict / not_found / rate_limit / permission /
		// plugin_not_detected — all business-level, exit 1.
		return ExitAPI
	}
}

// CLIError is the canonical typed error that internal/* layers return up
// to the cmd layer. The output layer translates it into an ErrorEnvelope
// + ExitError without further interpretation.
//
// Construct via package helpers (Invalid, NotLoggedIn, Conflict, ...) or
// directly when you need full control over Detail. Wrap underlying errors
// with Wrapped so that errors.Is/As keeps working through the boundary.
type CLIError struct {
	Type    ErrorType
	Code    int // optional upstream errno
	Message string
	Hint    string
	Detail  map[string]interface{}
	Wrapped error
}

func (e *CLIError) Error() string {
	if e.Wrapped != nil {
		return fmt.Sprintf("%s: %s: %v", e.Type, e.Message, e.Wrapped)
	}
	return fmt.Sprintf("%s: %s", e.Type, e.Message)
}

func (e *CLIError) Unwrap() error { return e.Wrapped }

// AsCLIError extracts a *CLIError from anywhere in the error chain.
// Returns (nil, false) if no CLIError is present.
func AsCLIError(err error) (*CLIError, bool) {
	var ce *CLIError
	if errors.As(err, &ce) {
		return ce, true
	}
	return nil, false
}

// ---- Constructor helpers (used everywhere except tests) ---------------

// Invalid is the canonical "your flags / args are bad" error. exit 2.
func Invalid(message string, hint string) *CLIError {
	return &CLIError{Type: TypeInvalidArgs, Message: message, Hint: hint}
}

// InvalidFlag flags a specific flag value as invalid; the Detail carries
// the offending flag name so Agents can correlate.
func InvalidFlag(flag, reason string) *CLIError {
	return &CLIError{
		Type:    TypeInvalidArgs,
		Message: fmt.Sprintf("invalid value for --%s: %s", flag, reason),
		Detail:  map[string]interface{}{"flag": flag, "reason": reason},
	}
}

// NotLoggedIn signals "the user has no emk on this machine". exit 3.
// Always paired with the canonical "Run `evercli auth login` first" hint
// so AI Agents know exactly what to ask for next.
func NotLoggedIn() *CLIError {
	return &CLIError{
		Type:    TypeNotLoggedIn,
		Message: "Not logged in",
		Hint:    "Run `evercli auth login` first",
	}
}

// AuthErr signals an emk-level authentication failure (invalid / expired /
// revoked). The optional apiKeyPrefix is surfaced as Detail.apiKeyPrefix
// so Agents can disambiguate when multiple sessions are in play.
func AuthErr(message, hint, apiKeyPrefix string) *CLIError {
	d := map[string]interface{}{}
	if apiKeyPrefix != "" {
		d["apiKeyPrefix"] = apiKeyPrefix
	}
	return &CLIError{Type: TypeAuth, Message: message, Hint: hint, Detail: d}
}

// Network signals a transport-layer failure (DNS / connect / TLS / read
// timeout). exit 4 — Agents may retry with backoff up to ~3x.
func Network(host string, cause error) *CLIError {
	return &CLIError{
		Type:    TypeNetwork,
		Message: "Network error contacting EverMe",
		Hint:    "Check your network and retry",
		Detail:  map[string]interface{}{"host": host, "cause": cause.Error()},
		Wrapped: cause,
	}
}

// Upstream wraps a backend errno failure. The Code is propagated so downstream
// tooling and humans can cross-reference EverMe support diagnostics.
func Upstream(code int, message, requestID string) *CLIError {
	d := map[string]interface{}{}
	if requestID != "" {
		d["requestId"] = requestID
	}
	return &CLIError{Type: TypeUpstream, Code: code, Message: message, Detail: d}
}

// Conflict represents a 409-style "already exists" or "idempotency
// collision". The detail bag is freeform so callers can stuff whatever
// disambiguating ids they have.
func Conflict(message string, detail map[string]interface{}) *CLIError {
	return &CLIError{Type: TypeConflict, Message: message, Detail: detail}
}

// NotFound — resource lookup failed.
func NotFound(resource, id string) *CLIError {
	return &CLIError{
		Type:    TypeNotFound,
		Message: fmt.Sprintf("%s not found", resource),
		Detail:  map[string]interface{}{"resource": resource, "id": id},
	}
}

// RateLimit — backend or transport-level throttling. retryAfterSec is the
// recommended sleep before retrying; 0 if the server didn't tell us.
func RateLimit(retryAfterSec int) *CLIError {
	d := map[string]interface{}{}
	if retryAfterSec > 0 {
		d["retryAfterSec"] = retryAfterSec
	}
	return &CLIError{
		Type:    TypeRateLimit,
		Message: "rate limited by EverMe",
		Hint:    "Wait the indicated delay then retry",
		Detail:  d,
	}
}

// IOErr — local filesystem failure. exit 5 (treated as internal because
// most IO errors at this layer indicate environmental problems).
//
// The cause's Error() is folded into Message so callers using the JSON
// envelope still see actionable detail (e.g. "credentials file foo.json
// has over-wide mode 0644; run `chmod 600 foo.json` to fix") rather than
// a bland "get failed on credential". Hint stays generic — actionable
// specifics live in Message.
func IOErr(path, op string, cause error) *CLIError {
	msg := fmt.Sprintf("%s failed on %s", op, path)
	if cause != nil {
		msg = fmt.Sprintf("%s failed on %s: %s", op, path, cause.Error())
	}
	return &CLIError{
		Type:    TypeIO,
		Message: msg,
		Hint:    "Check file permissions and disk space",
		Detail:  map[string]interface{}{"path": path, "op": op},
		Wrapped: cause,
	}
}

// Internal — last-resort bucket for unclassified errors. Surfaces the
// `evercli doctor` hint so users have a clear next step.
func Internal(cause error) *CLIError {
	msg := "internal error"
	if cause != nil {
		msg = cause.Error()
	}
	return &CLIError{
		Type:    TypeInternal,
		Message: msg,
		Hint:    "Run `evercli doctor` and report this issue if it persists",
		Wrapped: cause,
	}
}

// ---- Classification ----------------------------------------------------

// ClassifyError walks the error chain and returns a CLIError ready for
// rendering. It handles the well-known cases:
//   - already a *CLIError: return as-is
//   - context.Canceled / DeadlineExceeded: TypeCancelled
//   - everything else: TypeInternal
//
// Domain errors from internal/client and internal/credential should be
// converted at their own boundaries via Errorf-style helpers; this
// function is only the catch-all when those didn't fire.
func ClassifyError(err error) *CLIError {
	if err == nil {
		return nil
	}
	if ce, ok := AsCLIError(err); ok {
		return ce
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return &CLIError{
			Type:    TypeCancelled,
			Message: "operation cancelled",
		}
	}
	return Internal(err)
}
