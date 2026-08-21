package skill

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"evercli/internal/output"
)

const (
	hubErrNotFound      = 60001
	hubErrInvalidParams = 60002
	hubErrDownloadFail  = 60003
	hubErrRateLimit     = 60005
)

// HubClient is the skill-hub-base API surface used by skill commands.
type HubClient interface {
	SearchSkills(ctx context.Context, q string, page, limit int) (*SkillListResult, error)
	GetSkill(ctx context.Context, idOrName string) (*SkillDetail, error)
	// DownloadSkill streams the zip bytes for a skill and passes them to w.
	// It automatically appends ?source=cli to record the install event hub-side.
	DownloadSkill(ctx context.Context, idOrName string, w io.Writer) error
}

// SkillSummary matches skill-hub-base's SkillSummary schema.
type SkillSummary struct {
	ID           string   `json:"id"`
	SkillID      string   `json:"skill_id"`
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	Source       string   `json:"source"`
	Category     string   `json:"category"`
	QualityScore float64  `json:"quality_score"`
	Tags         []string `json:"tags"`
	BodyTokens   int      `json:"body_tokens"`
	License      string   `json:"license"`
	InstallCount int      `json:"install_count"`
	DownloadURL  string   `json:"download_url"`
}

// SkillDetail extends SkillSummary with full content.
type SkillDetail struct {
	SkillSummary
	SafetyFlags []string               `json:"safety_flags"`
	Subscores   map[string]interface{} `json:"subscores"`
	AddedAt     string                 `json:"added_at"`
	Files       []string               `json:"files"`
	SkillMD     string                 `json:"skill_md"`
}

// SkillListResult is returned by SearchSkills.
type SkillListResult struct {
	Items []SkillSummary `json:"items"`
	Total int            `json:"total"`
	Page  int            `json:"page"`
	Limit int            `json:"limit"`
}

// hubEnvelope is the wire format for all skill-hub-base responses.
type hubEnvelope struct {
	Error     string          `json:"error"`
	RequestID string          `json:"requestId"`
	Status    int             `json:"status"`
	Result    json.RawMessage `json:"result"`
}

type hubClient struct {
	baseURL string
	http    *http.Client
	ua      string
}

// NewHubClient returns a HubClient pointed at baseURL.
func NewHubClient(baseURL, userAgent string) HubClient {
	return &hubClient{
		baseURL: baseURL,
		http: &http.Client{
			Timeout: 60 * time.Second,
			Transport: &http.Transport{
				MaxIdleConns:          20,
				MaxIdleConnsPerHost:   5,
				IdleConnTimeout:       90 * time.Second,
				TLSHandshakeTimeout:   10 * time.Second,
				ResponseHeaderTimeout: 30 * time.Second,
				ForceAttemptHTTP2:     true,
			},
		},
		ua: userAgent,
	}
}

func (c *hubClient) SearchSkills(ctx context.Context, q string, page, limit int) (*SkillListResult, error) {
	params := url.Values{}
	if q != "" {
		params.Set("q", q)
	}
	params.Set("page", strconv.Itoa(page))
	params.Set("limit", strconv.Itoa(limit))
	params.Set("sort", "relevance")

	var out SkillListResult
	if err := c.get(ctx, "/openapi/v1/skills/search", params, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *hubClient) GetSkill(ctx context.Context, idOrName string) (*SkillDetail, error) {
	var out SkillDetail
	if err := c.get(ctx, "/openapi/v1/skills/"+url.PathEscape(idOrName), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *hubClient) DownloadSkill(ctx context.Context, idOrName string, w io.Writer) error {
	target := c.baseURL + "/openapi/v1/skills/" + url.PathEscape(idOrName) + "/download?source=cli"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return output.Internal(fmt.Errorf("build download request: %w", err))
	}
	req.Header.Set("User-Agent", c.ua)
	req.Header.Set("Accept", "application/zip")

	resp, err := c.http.Do(req)
	if err != nil {
		return output.Network(c.baseURL, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return output.NotFound("skill", idOrName)
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		return output.RateLimit(0)
	}
	if resp.StatusCode != http.StatusOK {
		return output.Upstream(resp.StatusCode, fmt.Sprintf("download returned HTTP %d", resp.StatusCode), "")
	}

	if _, err := io.Copy(w, io.LimitReader(resp.Body, 256<<20)); err != nil {
		return output.IOErr("download", "stream-zip", err)
	}
	return nil
}

// get performs a GET request against the hub and decodes the envelope result into out.
func (c *hubClient) get(ctx context.Context, path string, params url.Values, out any) error {
	target := c.baseURL + path
	if len(params) > 0 {
		target += "?" + params.Encode()
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return output.Internal(fmt.Errorf("build request: %w", err))
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", c.ua)

	resp, err := c.http.Do(req)
	if err != nil {
		return output.Network(c.baseURL, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return output.Network(c.baseURL, err)
	}

	if resp.StatusCode == http.StatusTooManyRequests {
		return output.RateLimit(0)
	}
	if resp.StatusCode == http.StatusNotFound {
		return output.NotFound("skill", path)
	}

	var env hubEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		return output.Upstream(resp.StatusCode, "unexpected response from skill hub", "")
	}

	if env.Status != 0 {
		return classifyHubError(env.Status, env.Error, "")
	}

	if out != nil {
		if err := json.Unmarshal(env.Result, out); err != nil {
			return output.Internal(fmt.Errorf("decode hub result: %w", err))
		}
	}
	return nil
}

// post performs an authenticated POST request against the hub (no body expected in result).
func (c *hubClient) post(ctx context.Context, path string, in any) error {
	var bodyReader io.Reader
	if in != nil {
		raw, err := json.Marshal(in)
		if err != nil {
			return output.Internal(fmt.Errorf("marshal request: %w", err))
		}
		bodyReader = bytes.NewReader(raw)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bodyReader)
	if err != nil {
		return output.Internal(fmt.Errorf("build request: %w", err))
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", c.ua)
	if bodyReader != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return output.Network(c.baseURL, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusTooManyRequests {
		return output.RateLimit(0)
	}

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	var env hubEnvelope
	if err := json.Unmarshal(body, &env); err != nil || env.Status != 0 {
		// non-critical path; caller can ignore
		return classifyHubError(env.Status, env.Error, "")
	}
	return nil
}

func classifyHubError(status int, msg, requestID string) *output.CLIError {
	switch status {
	case hubErrNotFound:
		return output.NotFound("skill", "")
	case hubErrInvalidParams:
		return output.Invalid(msg, "")
	case hubErrRateLimit:
		return output.RateLimit(0)
	default:
		return output.Upstream(status, msg, requestID)
	}
}
