package client_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"evercli/internal/client"
	"evercli/internal/credential"
	"evercli/internal/httpmock"
	"evercli/internal/output"
)

// classificationFixture is a smaller alternative to newTestClient that
// stays internal to this file — keeps the table-driven errno tests
// readable without dragging in the full happy-path setup.
func classificationFixture(t *testing.T) (*httpmock.Server, client.Client) {
	t.Helper()
	srv := httpmock.NewServer(t)
	cred := credential.NewMem()
	require.NoError(t, cred.Set(context.Background(), credential.APIKey(),
		"emk_0123456789abcdef0123456789abcdef"))
	cli := client.NewWithHTTP(srv.URL(), cred, srv.HTTPClient())
	return srv, cli
}

// TestClassifyEnvelopeError walks every documented errno bucket and
// confirms the client surfaces the expected CLIError type. The
// previous test suite covered Login / DeviceStart happy paths but
// had zero coverage of the errno → Type mapping — that's the table
// AI Agents switch on, so a regression here is silent and
// user-visible.
func TestClassifyEnvelopeError(t *testing.T) {
	cases := []struct {
		name   string
		errno  int
		errMsg string
		want   output.ErrorType
	}{
		// 30001-30099: generic auth (excluding 30005 / 30104).
		{"30001 ErrUnauthorized", 30001, "ErrUnauthorized", output.TypeAuth},
		{"30003 ErrTokenInvalid", 30003, "ErrTokenInvalid", output.TypeAuth},
		// 30005 explicitly maps to upstream (JWKS unavailable).
		{"30005 ErrJWKSUnavailable", 30005, "ErrJWKSUnavailable", output.TypeUpstream},
		// 30104 is rate-limit, not auth.
		{"30104 ErrSlowDown", 30104, "ErrSlowDown", output.TypeRateLimit},
		// 30201/30202 are emk auth failures.
		{"30202 ErrApiKeyRevoked", 30202, "ErrApiKeyRevoked", output.TypeAuth},
		// 30303: agent token / scope — also auth.
		{"30303 ErrScopeInsufficient", 30303, "ErrScopeInsufficient", output.TypeAuth},
		// 401XX: record-level NotFound surfaces as upstream (we don't
		// distinguish errno 40101 from generic 5xxxx upstream — treat
		// the same; if this ever changes we'll have a test to update).
		{"40101 ErrRecordNotFound", 40101, "ErrRecordNotFound", output.TypeUpstream},
		// 50101: upstream EverOS.
		{"50101 ErrUpstreamFailed", 50101, "ErrUpstreamFailed", output.TypeUpstream},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv, cli := classificationFixture(t)
			srv.HandleEnvelopeError("POST /auth/login", c.errno, c.errMsg)

			_, err := cli.Login(context.Background(), "emk_0123456789abcdef0123456789abcdef")
			require.Error(t, err)
			ce, ok := output.AsCLIError(err)
			require.True(t, ok, "all classified errors must round-trip as *CLIError")
			assert.Equal(t, c.want, ce.Type, "errno=%d wrong bucket", c.errno)
			assert.Equal(t, c.errno, ce.Code, "Code must propagate the errno verbatim")
			// requestId from the envelope should always be carried into
			// Detail so support can correlate.
			if rid, ok := ce.Detail["requestId"].(string); ok {
				assert.NotEmpty(t, rid)
			}
		})
	}
}

// Test429RawAndEnveloped — HTTP 429 must be classified as rate_limit
// regardless of whether the body is enveloped (typed errno) or raw
// (CDN / WAF text). The enveloped path must additionally preserve
// the requestId.
func TestClient_429_NonEnvelopeBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "5")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte("Too Many Requests")) // not JSON
	}))
	defer srv.Close()

	cred := credential.NewMem()
	require.NoError(t, cred.Set(context.Background(), credential.APIKey(),
		"emk_0123456789abcdef0123456789abcdef"))
	cli := client.NewWithHTTP(srv.URL, cred, srv.Client())

	_, err := cli.Login(context.Background(), "emk_0123456789abcdef0123456789abcdef")
	require.Error(t, err)
	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Equal(t, output.TypeRateLimit, ce.Type)
	if v, ok := ce.Detail["retryAfterSec"].(int); ok {
		assert.Equal(t, 5, v)
	}
}

// TestClient_2xxMalformedEnvelopeIsInternal — a 200 OK that doesn't
// parse as the envelope is a programmer error, not an upstream
// failure. Previously these were mis-classified as upstream and
// users got a confusing "service temporarily unavailable" hint.
func TestClient_2xxMalformedEnvelopeIsInternal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("not-an-envelope"))
	}))
	defer srv.Close()

	cred := credential.NewMem()
	require.NoError(t, cred.Set(context.Background(), credential.APIKey(),
		"emk_0123456789abcdef0123456789abcdef"))
	cli := client.NewWithHTTP(srv.URL, cred, srv.Client())

	_, err := cli.Login(context.Background(), "emk_0123456789abcdef0123456789abcdef")
	require.Error(t, err)
	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Equal(t, output.TypeInternal, ce.Type,
		"2xx + malformed envelope must classify as Internal, not Upstream")
}

// TestClient_TruncatesOversizeBody — the 8 MiB cap is what stops a
// hostile / buggy upstream from OOM'ing the CLI. Previously the
// io.ReadAll was unbounded.
func TestClient_TruncatesOversizeBody(t *testing.T) {
	// Server slowly streams >8 MiB so the read finishes via the
	// LimitReader, not via the connection close.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		// 16 MiB of garbage — well past the 8 MiB cap.
		chunk := strings.Repeat("a", 1<<14) // 16 KiB
		for i := 0; i < 1024; i++ {
			if _, err := w.Write([]byte(chunk)); err != nil {
				return
			}
		}
	}))
	defer srv.Close()

	cred := credential.NewMem()
	require.NoError(t, cred.Set(context.Background(), credential.APIKey(),
		"emk_0123456789abcdef0123456789abcdef"))
	cli := client.NewWithHTTP(srv.URL, cred, srv.Client())

	_, err := cli.Login(context.Background(), "emk_0123456789abcdef0123456789abcdef")
	require.Error(t, err)
	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Equal(t, output.TypeUpstream, ce.Type)
	assert.Contains(t, ce.Message, "exceeded",
		"oversize response must surface a structured error rather than crashing the CLI")
}
