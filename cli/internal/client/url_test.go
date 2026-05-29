package client

import (
	"net/http"
	"net/url"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNormalizeBaseURL(t *testing.T) {
	cases := []struct {
		in, want, why string
	}{
		{
			in:   "https://api.everme.evermind.ai",
			want: "https://api.everme.evermind.ai/api/v1",
			why:  "empty path is the auto-prefix happy path",
		},
		{
			in:   "https://api.everme.evermind.ai/",
			want: "https://api.everme.evermind.ai/api/v1",
			why:  "trailing slash is treated like empty path",
		},
		{
			in:   "https://api.everme.evermind.ai/api/v1",
			want: "https://api.everme.evermind.ai/api/v1",
			why:  "exactly /api/v1 is idempotent",
		},
		{
			in:   "https://api.everme.evermind.ai/api/v1/",
			want: "https://api.everme.evermind.ai/api/v1",
			why:  "trailing slash on the canonical prefix is normalized away",
		},
		{
			in:   "https://api.everme.evermind.ai/api/v10",
			want: "https://api.everme.evermind.ai/api/v10",
			why:  "user-supplied non-canonical path is preserved verbatim — better a clear 404 than silent /api/v10/api/v1",
		},
		{
			in:   "https://api.everme.evermind.ai/api/v2",
			want: "https://api.everme.evermind.ai/api/v2",
			why:  "future-major paths must not be double-prefixed",
		},
		{
			in:   "http://localhost:8080",
			want: "http://localhost:8080/api/v1",
			why:  "dev / staging hosts get the prefix when path is empty",
		},
	}
	for _, c := range cases {
		t.Run(c.in, func(t *testing.T) {
			assert.Equal(t, c.want, normalizeBaseURL(c.in), c.why)
		})
	}
}

func TestJoinURL_RespectsLeadingSlash(t *testing.T) {
	got, err := joinURL("https://api.everme.evermind.ai/api/v1", "/auth/login", nil)
	require.NoError(t, err)
	assert.Equal(t, "https://api.everme.evermind.ai/api/v1/auth/login", got)

	got, err = joinURL("https://api.everme.evermind.ai/api/v1", "auth/login", nil) // no leading slash
	require.NoError(t, err)
	assert.Equal(t, "https://api.everme.evermind.ai/api/v1/auth/login", got, "missing leading slash must NOT produce …v1auth/login")
}

func TestJoinURL_EncodesQuery(t *testing.T) {
	q := url.Values{"foo": {"a b"}, "bar": {"1"}}
	got, err := joinURL("https://api.everme.evermind.ai/api/v1", "/things", q)
	require.NoError(t, err)
	assert.Contains(t, got, "foo=a+b")
	assert.Contains(t, got, "bar=1")
}

func TestParseRetryAfter(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"", 0},
		{"0", 0},
		{"5", 5},
		{"   42   ", 42},
		{"-1", 0},
		{"not-a-number", 0},
		// Adversarial / clock-skewed servers must not park us for hours.
		{"99999", retryAfterCap},
	}
	for _, c := range cases {
		t.Run(c.in, func(t *testing.T) {
			assert.Equal(t, c.want, parseRetryAfter(c.in))
		})
	}
}

func TestParseRetryAfter_HTTPDate(t *testing.T) {
	// 30s in the future, formatted as IMF-fixdate (RFC 7231).
	future := []byte("Sun, 06 Nov 2095 08:49:37 GMT") // safely in the future
	n := parseRetryAfter(string(future))
	assert.Greater(t, n, 0, "HTTP-date form must produce a positive sleep delta (was a CDN-driven tight-loop bug previously)")
	assert.LessOrEqual(t, n, retryAfterCap, "far-future dates must be clamped, not parked for hours")

	// http.ParseTime sanity
	if _, err := http.ParseTime(string(future)); err != nil {
		t.Fatal(err)
	}
}

func TestJoinURL_PreservesBaseRawQuery(t *testing.T) {
	got, err := joinURL("https://api.everme.evermind.ai/api/v1?tenant=acme", "/things", nil)
	require.NoError(t, err)
	assert.Contains(t, got, "tenant=acme",
		"baseURL ?query parameters must survive request building (regression: previously dropped silently)")
}

func TestJoinURL_MergesQueryValues(t *testing.T) {
	got, err := joinURL("https://api.everme.evermind.ai/api/v1?tenant=acme", "/things", map[string][]string{"limit": {"10"}})
	require.NoError(t, err)
	assert.Contains(t, got, "tenant=acme")
	assert.Contains(t, got, "limit=10")
}
