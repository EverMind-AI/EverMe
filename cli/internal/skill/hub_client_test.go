package skill_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"evercli/internal/skill"
)

// hubEnvelope mirrors the skill-hub-base response shape used in tests.
type hubEnvelope struct {
	Error     string      `json:"error"`
	RequestID string      `json:"requestId"`
	Status    int         `json:"status"`
	Result    interface{} `json:"result,omitempty"`
}

// hubFixture is a lightweight mock for skill-hub-base.
type hubFixture struct {
	t      *testing.T
	mux    *http.ServeMux
	server *httptest.Server
	client skill.HubClient
}

func newHubFixture(t *testing.T) *hubFixture {
	t.Helper()
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	cli := skill.NewHubClient(srv.URL, "evercli/test")
	return &hubFixture{t: t, mux: mux, server: srv, client: cli}
}

// envelope replies with a success envelope wrapping result.
func (f *hubFixture) envelope(route string, result interface{}) {
	f.mux.HandleFunc(route, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(hubEnvelope{Error: "success", RequestID: "req-mock", Status: 0, Result: result})
	})
}

// envelopeError replies with a non-zero skill-hub-base status code.
func (f *hubFixture) envelopeError(route string, status int, msg string) {
	f.mux.HandleFunc(route, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(hubEnvelope{Error: msg, RequestID: "req-mock", Status: status})
	})
}

// httpStatus replies with a bare HTTP status code (no envelope).
func (f *hubFixture) httpStatus(route string, code int) {
	f.mux.HandleFunc(route, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(code)
	})
}

// ---- SearchSkills ---------------------------------------------------------

func TestHubClient_SearchSkills_Happy(t *testing.T) {
	f := newHubFixture(t)
	f.envelope("GET /openapi/v1/skills/search", map[string]interface{}{
		"items": []interface{}{
			map[string]interface{}{
				"id":            "11111111-1111-1111-1111-111111111111",
				"skill_id":      "awesome:user/code-reviewer",
				"name":          "code-reviewer",
				"description":   "Reviews code",
				"quality_score": 0.92,
				"install_count": 12300,
				"tags":          []string{"review"},
			},
		},
		"total": 1,
		"page":  1,
		"limit": 20,
	})

	result, err := f.client.SearchSkills(context.Background(), "code review", 1, 20)
	require.NoError(t, err)
	require.Len(t, result.Items, 1)
	assert.Equal(t, "code-reviewer", result.Items[0].Name)
	assert.Equal(t, "awesome:user/code-reviewer", result.Items[0].SkillID)
	assert.InDelta(t, 0.92, result.Items[0].QualityScore, 0.001)
	assert.Equal(t, 1, result.Total)
}

func TestHubClient_SearchSkills_EmptyQuery(t *testing.T) {
	f := newHubFixture(t)
	f.envelope("GET /openapi/v1/skills/search", map[string]interface{}{
		"items": []interface{}{},
		"total": 0, "page": 1, "limit": 20,
	})

	result, err := f.client.SearchSkills(context.Background(), "", 1, 20)
	require.NoError(t, err)
	assert.Empty(t, result.Items)
}

func TestHubClient_SearchSkills_RateLimit(t *testing.T) {
	f := newHubFixture(t)
	f.httpStatus("GET /openapi/v1/skills/search", http.StatusTooManyRequests)

	_, err := f.client.SearchSkills(context.Background(), "x", 1, 20)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "rate_limit")
}

// ---- GetSkill -------------------------------------------------------------

func TestHubClient_GetSkill_Happy(t *testing.T) {
	f := newHubFixture(t)
	f.envelope("GET /openapi/v1/skills/code-reviewer", map[string]interface{}{
		"id":            "11111111-1111-1111-1111-111111111111",
		"skill_id":      "awesome:user/code-reviewer",
		"name":          "code-reviewer",
		"description":   "Reviews your code with AI",
		"quality_score": 0.92,
		"install_count": 5000,
		"tags":          []string{"coding", "review"},
		"skill_md":      "# Code Reviewer\nThis skill reviews your code.",
		"files":         []string{"SKILL.md"},
	})

	detail, err := f.client.GetSkill(context.Background(), "code-reviewer")
	require.NoError(t, err)
	assert.Equal(t, "code-reviewer", detail.Name)
	assert.Equal(t, "awesome:user/code-reviewer", detail.SkillID)
	assert.Contains(t, detail.SkillMD, "Code Reviewer")
	assert.Equal(t, []string{"SKILL.md"}, detail.Files)
}

func TestHubClient_GetSkill_NotFound(t *testing.T) {
	f := newHubFixture(t)
	f.envelopeError("GET /openapi/v1/skills/nonexistent", 60001, "not_found")

	_, err := f.client.GetSkill(context.Background(), "nonexistent")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not_found")
}

func TestHubClient_GetSkill_HTTP404(t *testing.T) {
	f := newHubFixture(t)
	f.httpStatus("GET /openapi/v1/skills/gone", http.StatusNotFound)

	_, err := f.client.GetSkill(context.Background(), "gone")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not_found")
}

// ---- DownloadSkill --------------------------------------------------------

func TestHubClient_DownloadSkill_Happy(t *testing.T) {
	f := newHubFixture(t)
	fakeZip := []byte("PK\x03\x04fake-zip-content")
	f.mux.HandleFunc("GET /openapi/v1/skills/code-reviewer/download", func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "cli", r.URL.Query().Get("source"), "source=cli must be appended")
		w.Header().Set("Content-Type", "application/zip")
		w.Write(fakeZip)
	})

	var buf bytes.Buffer
	err := f.client.DownloadSkill(context.Background(), "code-reviewer", &buf)
	require.NoError(t, err)
	assert.Equal(t, fakeZip, buf.Bytes())
}

func TestHubClient_DownloadSkill_NotFound(t *testing.T) {
	f := newHubFixture(t)
	f.httpStatus("GET /openapi/v1/skills/gone/download", http.StatusNotFound)

	var buf bytes.Buffer
	err := f.client.DownloadSkill(context.Background(), "gone", &buf)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not_found")
}

func TestHubClient_DownloadSkill_RateLimit(t *testing.T) {
	f := newHubFixture(t)
	f.httpStatus("GET /openapi/v1/skills/x/download", http.StatusTooManyRequests)

	var buf bytes.Buffer
	err := f.client.DownloadSkill(context.Background(), "x", &buf)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "rate_limit")
}
