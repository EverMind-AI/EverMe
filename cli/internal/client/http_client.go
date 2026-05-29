package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"evercli/internal/credential"
	"evercli/internal/output"
)

// maxResponseBytes caps how much we will read from a response body.
// EverMe envelopes are tiny (<1 KiB typical), so 8 MiB is a generous
// upper bound that still protects the CLI from a misbehaving / hostile
// upstream serving an unbounded stream.
const maxResponseBytes = 8 << 20

// defaultTransport is shared across every Client constructed via New so
// connection pooling is actually pooled. The default http.DefaultTransport
// caps MaxIdleConnsPerHost at 2 — fine for one-shot calls but a serial
// throttle for the importer's per-record presign+CreateRecord pipeline.
var defaultTransport = &http.Transport{
	Proxy:                 http.ProxyFromEnvironment,
	MaxIdleConns:          50,
	MaxIdleConnsPerHost:   10,
	IdleConnTimeout:       90 * time.Second,
	TLSHandshakeTimeout:   10 * time.Second,
	ExpectContinueTimeout: 1 * time.Second,
	ResponseHeaderTimeout: 30 * time.Second,
	ForceAttemptHTTP2:     true,
}

// httpClient is the production net/http-backed Client. It speaks the
// EverMe response envelope (status / error / requestId / result) and
// converts every non-success outcome into a *output.CLIError so callers
// get a single, structured error type to switch on.
//
// No transport-level retry is performed. Device Flow polling intervals
// come from the server's `interval` field in DeviceStartResp; importer
// idempotency-conflict retry is implemented in internal/importer at the
// /mem/records boundary. If broader retry becomes necessary, swap in
// hashicorp/go-retryablehttp here without touching callers.
type httpClient struct {
	baseURL string
	http    *http.Client
	cred    credential.Provider
	ua      string
}

// apiPathPrefix is appended to every request path. Backend mounts all
// API routes under /api/v1; we normalize here so callers and tests pass
// "/auth/login" rather than "/api/v1/auth/login" everywhere.
//
// If the supplied baseURL already ends in /api/v1 we strip it so the
// final URL has the prefix exactly once. This keeps configurations like
// `api_base_url: https://api.everme.evermind.ai` and `https://api.everme.evermind.ai/api/v1`
// both working.
const apiPathPrefix = "/api/v1"

// New returns the canonical Client implementation pointed at baseURL.
// The /api/v1 prefix is auto-appended (idempotently — supplying a
// baseURL that already ends in /api/v1 still works).
//
// The credential provider is consulted lazily — methods that don't need
// auth (DeviceStart / DeviceToken / Login) skip the lookup entirely.
//
// The returned Client should be reused; callers should not invoke New
// per request as that would defeat the shared Transport's connection
// pool. cmdctx.BuildDeps caches the Client into Deps for that reason.
func New(baseURL string, cred credential.Provider) Client {
	base := normalizeBaseURL(baseURL)
	return &httpClient{
		baseURL: base,
		http: &http.Client{
			Transport: defaultTransport,
			Timeout:   60 * time.Second,
		},
		cred: cred,
		ua:   "evercli/dev",
	}
}

// normalizeBaseURL canonicalizes a user-supplied baseURL into the
// shape `<scheme>://<host>[:<port>]/api/v1`. We auto-append the prefix
// in only one situation: the input has NO path (or just "/"). If the
// caller already specified some path we leave it verbatim — including
// hypothetical future majors like `/api/v2` — and let the request
// 404 against the user's literal URL with a clear error rather than
// silently double-prefixing into a meaningless `/api/v2/api/v1` path.
//
// Rationale: silent rewriting of a hand-typed URL was masking the most
// common config typo ("v10" instead of "v1"); the user got a confusing
// 404 with no breadcrumb back to the synthesized path. "No fake
// fallbacks" — when the config is wrong we say so.
func normalizeBaseURL(in string) string {
	trimmed := strings.TrimRight(in, "/")
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme == "" {
		// Couldn't parse — fall back to literal append; downstream
		// requests will surface the malformed URL clearly.
		return strings.TrimRight(trimmed, "/") + apiPathPrefix
	}
	cleaned := path.Clean("/" + parsed.Path)
	switch cleaned {
	case "/", "":
		// Empty path is the only auto-prefix case.
		parsed.Path = apiPathPrefix
	default:
		// Caller supplied a path — respect it verbatim. If they meant
		// to prefix /api/v1 they can write it; if they wrote /api/v10
		// we leave it alone so the 404 points at the real URL, not at
		// a fabricated /api/v10/api/v1.
		parsed.Path = cleaned
	}
	return strings.TrimRight(parsed.String(), "/")
}

// NewWithHTTP is the test-friendly constructor. It accepts the baseURL
// verbatim (no /api/v1 mangling) so httpmock servers don't need to
// register prefixed routes. Production code uses New(); tests use this.
func NewWithHTTP(baseURL string, cred credential.Provider, hc *http.Client) Client {
	return &httpClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		http:    hc,
		cred:    cred,
		ua:      "evercli/dev",
	}
}

// SetUserAgent overrides the User-Agent header. Wired from main.go once
// build version is known.
func (c *httpClient) SetUserAgent(ua string) { c.ua = ua }

// authMode describes how do() should populate Authorization.
type authMode int

const (
	authNone   authMode = iota // public endpoint
	authBearer                 // Authorization: Bearer <emk> from credential.Provider
	authAgent                  // Authorization: Bearer <evt> from credential.Provider
)

// do is the single funnel for every request. It builds, signs, executes,
// decodes the envelope, and translates failure into output.CLIError.
//
// in is the JSON body (nil → no body). out is the destination for the
// envelope's `result` payload (nil → discard). query is appended as a
// querystring; empty values are skipped.
func (c *httpClient) do(
	ctx context.Context,
	method, requestPath string,
	query url.Values,
	in any,
	out any,
	mode authMode,
) error {
	target, err := joinURL(c.baseURL, requestPath, query)
	if err != nil {
		return output.Internal(fmt.Errorf("build url: %w", err))
	}

	var body io.Reader
	if in != nil {
		raw, err := json.Marshal(in)
		if err != nil {
			return output.Internal(fmt.Errorf("marshal request: %w", err))
		}
		body = bytes.NewReader(raw)
	}

	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return output.Internal(fmt.Errorf("build request: %w", err))
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", c.ua)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	if mode == authBearer {
		emk, err := c.cred.Get(ctx, credential.APIKey())
		if err != nil {
			if errors.Is(err, credential.ErrNotFound) {
				return output.NotLoggedIn()
			}
			return output.Internal(fmt.Errorf("read credential: %w", err))
		}
		req.Header.Set("Authorization", "Bearer "+emk)
	}
	if mode == authAgent {
		evt, err := c.cred.Get(ctx, credential.AgentToken())
		if err != nil {
			if errors.Is(err, credential.ErrNotFound) {
				return output.NotLoggedIn()
			}
			return output.Internal(fmt.Errorf("read agent credential: %w", err))
		}
		req.Header.Set("Authorization", "Bearer "+evt)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return classifyTransportError(req, err)
	}
	defer resp.Body.Close()

	// Cap how much we'll read so a malicious or buggy upstream can't
	// OOM the CLI by streaming an unbounded response.
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		// User-initiated SIGINT during the body read should classify as
		// cancelled, not as a network error.
		if ctx.Err() != nil {
			return classifyTransportError(req, ctx.Err())
		}
		return output.Network(req.URL.Host, fmt.Errorf("read body: %w", err))
	}
	if len(raw) > maxResponseBytes {
		return output.Upstream(resp.StatusCode,
			fmt.Sprintf("response body exceeded %d bytes", maxResponseBytes), "")
	}

	// HTTP 429 is an explicit rate-limit signal. Some upstreams send
	// envelope-shaped 429s (errno 30104 / 20005); others send raw
	// HTML. Try envelope first so requestId / errno survive when the
	// backend bothered to populate them, fall back to status-only
	// classification otherwise.
	if resp.StatusCode == http.StatusTooManyRequests {
		retry := parseRetryAfter(resp.Header.Get("Retry-After"))
		var env backendEnvelope
		if jsonErr := json.Unmarshal(raw, &env); jsonErr == nil && env.Status != 0 {
			ce := &output.CLIError{
				Type:    output.TypeRateLimit,
				Code:    env.Status,
				Message: backendErrorMessage(env),
				Hint:    "Slow down polling and try again",
				Detail:  detailWithRequestID(env.RequestID, nil),
			}
			if retry > 0 {
				if ce.Detail == nil {
					ce.Detail = map[string]interface{}{}
				}
				ce.Detail["retryAfterSec"] = retry
			}
			return ce
		}
		return output.RateLimit(retry)
	}

	// Non-2xx without a parseable envelope: surface as upstream with the
	// HTTP status as a synthetic errno (encoded as 5xx*1000 etc.). This
	// keeps Code populated so AI Agents can still switch on something.
	var env backendEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		switch {
		case resp.StatusCode/100 == 2:
			// 2xx body that didn't parse as the envelope is a real
			// programmer error — call it Internal so the bug surfaces
			// rather than being mis-classified as upstream.
			return output.Internal(fmt.Errorf("malformed envelope (status %d): %w", resp.StatusCode, err))
		case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
			return output.AuthErr("unauthorized", "Run `evercli auth login` to re-authenticate", "")
		default:
			return output.Upstream(resp.StatusCode, http.StatusText(resp.StatusCode), "")
		}
	}

	if env.Status == 0 {
		if out != nil && len(env.Result) > 0 && string(env.Result) != "null" {
			if err := json.Unmarshal(env.Result, out); err != nil {
				return output.Internal(fmt.Errorf("decode result: %w", err))
			}
		}
		return nil
	}

	return classifyEnvelopeError(env)
}

// joinURL builds the final request URL safely. Path segments are
// composed with path.Join so a missing leading slash on the caller's
// side doesn't produce `https://api.everme.evermind.aiauth/login`. The
// baseURL's RawQuery / Fragment are preserved and merged so a config
// like `https://api.everme.evermind.ai?tenant=xx` survives request building.
func joinURL(baseURL, requestPath string, query url.Values) (string, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return "", err
	}
	parsed.Path = path.Join("/", parsed.Path, requestPath)
	switch {
	case len(query) > 0 && parsed.RawQuery != "":
		// Merge: caller-supplied values win on key collision (Set
		// overwrites Add). This keeps the behaviour predictable for
		// per-request overrides while still carrying base-URL
		// parameters into the request.
		merged, err := url.ParseQuery(parsed.RawQuery)
		if err != nil {
			return "", fmt.Errorf("parse base raw query: %w", err)
		}
		for k, vs := range query {
			merged[k] = vs
		}
		parsed.RawQuery = merged.Encode()
	case len(query) > 0:
		parsed.RawQuery = query.Encode()
	}
	return parsed.String(), nil
}

// retryAfterCap clamps a remote-supplied wait so a clock-skewed or
// adversarial server can't park the CLI for hours. 5 minutes is more
// than enough for any legitimate backoff (Device Flow polling lives
// at ~5s) while still fitting under the typical CI job's idle window.
const retryAfterCap = 5 * 60

// parseRetryAfter handles both RFC 7231 forms: a delta in seconds, or
// an HTTP-date. CDNs / WAFs in front of the API may rewrite the seconds
// form to a date string; ignoring that gave us tight retry loops in
// the previous Atoi-only implementation.
//
// We round UP (ceil) the date form so a 600 ms remaining interval
// doesn't truncate to 0 (which would loop tight). Negative or absurdly
// large values are clamped — see retryAfterCap.
func parseRetryAfter(v string) int {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	if n, err := strconv.Atoi(v); err == nil {
		return clampRetryAfter(n)
	}
	if t, err := http.ParseTime(v); err == nil {
		d := time.Until(t)
		if d <= 0 {
			return 0
		}
		// Ceil: any sub-second remainder becomes a 1-second wait.
		secs := int((d + time.Second - 1) / time.Second)
		return clampRetryAfter(secs)
	}
	return 0
}

func clampRetryAfter(n int) int {
	if n < 0 {
		return 0
	}
	if n > retryAfterCap {
		return retryAfterCap
	}
	return n
}

// classifyTransportError converts net/http errors into the CLIError
// taxonomy. context errors take precedence (so SIGINT halfway through
// a request becomes type=cancelled, not type=network).
func classifyTransportError(req *http.Request, err error) error {
	if errors.Is(err, context.Canceled) {
		return &output.CLIError{Type: output.TypeCancelled, Message: "request cancelled"}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &output.CLIError{Type: output.TypeCancelled, Message: "request deadline exceeded"}
	}
	host := ""
	if req != nil && req.URL != nil {
		host = req.URL.Host
	}
	return output.Network(host, err)
}

// classifyEnvelopeError translates a non-zero backend status into a
// CLIError of the appropriate type, preserving requestId in Detail and
// Code so error.code surfaces the upstream errno.
func classifyEnvelopeError(env backendEnvelope) error {
	switch {
	case isAuthErrno(env.Status):
		return &output.CLIError{
			Type:    output.TypeAuth,
			Code:    env.Status,
			Message: backendErrorMessage(env),
			Hint:    "Run `evercli auth login` to re-authenticate",
			Detail:  detailWithRequestID(env.RequestID, nil),
		}
	case isRateLimitErrno(env.Status):
		return &output.CLIError{
			Type:    output.TypeRateLimit,
			Code:    env.Status,
			Message: backendErrorMessage(env),
			Hint:    "Slow down polling and try again",
			Detail:  detailWithRequestID(env.RequestID, nil),
		}
	default:
		return &output.CLIError{
			Type:    output.TypeUpstream,
			Code:    env.Status,
			Message: backendErrorMessage(env),
			Detail:  detailWithRequestID(env.RequestID, nil),
		}
	}
}

func backendErrorMessage(env backendEnvelope) string {
	if env.Error != "" {
		return env.Error
	}
	return fmt.Sprintf("upstream errno %d", env.Status)
}

func detailWithRequestID(rid string, base map[string]interface{}) map[string]interface{} {
	if rid == "" && len(base) == 0 {
		return nil
	}
	d := make(map[string]interface{}, len(base)+1)
	for k, v := range base {
		d[k] = v
	}
	if rid != "" {
		d["requestId"] = rid
	}
	return d
}

// ---- Method implementations ------------------------------------------

func (c *httpClient) DeviceStart(ctx context.Context, req DeviceStartReq) (*DeviceStartResp, error) {
	var resp DeviceStartResp
	if err := c.do(ctx, http.MethodPost, "/auth/device", nil, req, &resp, authNone); err != nil {
		return nil, err
	}
	return &resp, nil
}

func (c *httpClient) DeviceToken(ctx context.Context, deviceCode string) (*DeviceTokenResp, error) {
	// Backend requires grantType per RFC 8628; missing it → 400.
	body := DeviceTokenReq{DeviceCode: deviceCode, GrantType: "device_code"}
	var resp DeviceTokenResp
	if err := c.do(ctx, http.MethodPost, "/auth/token", nil, body, &resp, authNone); err != nil {
		return nil, err
	}
	return &resp, nil
}

// loginReq is a typed DTO so the camelCase tag rule survives renames.
// String() is overridden so the apiKey doesn't leak through generic
// fmt.Sprintf("%+v") debug paths.
type loginReq struct {
	APIKey string `json:"apiKey"`
}

func (l loginReq) String() string { return "loginReq{apiKey=<redacted>}" }

func (c *httpClient) Login(ctx context.Context, apiKey string) (*LoginResp, error) {
	body := loginReq{APIKey: apiKey}
	var resp LoginResp
	if err := c.do(ctx, http.MethodPost, "/auth/login", nil, body, &resp, authNone); err != nil {
		return nil, err
	}
	return &resp, nil
}

// (httpClient.Me retired; auth.Service.Me hits /auth/login instead.)

func (c *httpClient) ListAgents(ctx context.Context, filter AgentFilter) ([]Agent, error) {
	body := struct {
		Platform           string `json:"platform,omitempty"`
		MachineFingerprint string `json:"machineFingerprint,omitempty"`
	}{
		Platform:           filter.Platform,
		MachineFingerprint: filter.MachineFingerprint,
	}
	var resp struct {
		Items []Agent `json:"items"`
	}
	if err := c.do(ctx, http.MethodPost, "/agents/list", nil, body, &resp, authBearer); err != nil {
		return nil, err
	}
	return resp.Items, nil
}

func (c *httpClient) RegisterAgent(ctx context.Context, req RegisterAgentReq) (*RegisterAgentResp, error) {
	var resp RegisterAgentResp
	if err := c.do(ctx, http.MethodPost, "/agents", nil, req, &resp, authBearer); err != nil {
		return nil, err
	}
	return &resp, nil
}

// (DisconnectAgent retired with `evercli plugin uninstall`.)

func (c *httpClient) Presign(ctx context.Context, req PresignReq) (*PresignResp, error) {
	var resp PresignResp
	if err := c.do(ctx, http.MethodPost, "/mem/uploads/presign", nil, req, &resp, authAgent); err != nil {
		return nil, err
	}
	return &resp, nil
}

func (c *httpClient) CreateRecord(ctx context.Context, req CreateRecordReq) (*CreateRecordResp, error) {
	var resp CreateRecordResp
	if err := c.do(ctx, http.MethodPost, "/mem/sources", nil, req, &resp, authAgent); err != nil {
		return nil, err
	}
	return &resp, nil
}
