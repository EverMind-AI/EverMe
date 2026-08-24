package skill

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"evercli/internal/credential"
	"evercli/internal/logger"
	"evercli/internal/output"
)

// InstallRecord describes a skill install event to sync to the everme backend.
type InstallRecord struct {
	SkillID     string    `json:"skillId"`
	SkillName   string    `json:"skillName"`
	Agents      []string  `json:"agents"`
	Scope       string    `json:"scope"` // "project" | "global"
	InstalledAt time.Time `json:"installedAt"`
}

// EvermeSync records skill install/remove events on the everme backend so
// the web skill management page can display them.
//
// All methods are best-effort: failures are logged at warn level and never
// propagate to callers. Local skill operations must never block on sync.
//
// NOTE: the backing endpoints (POST /api/v1/skills/installs and
// DELETE /api/v1/skills/installs/:skill_id) are backend work — the CLI
// pre-wires the calls and they become active once the backend ships them.
type EvermeSync struct {
	apiBaseURL string
	cred       credential.Provider
	http       *http.Client
	ua         string
}

// NewEvermeSync returns a sync helper. Pass a nil cred to get a no-op helper
// for unauthenticated sessions.
func NewEvermeSync(apiBaseURL string, cred credential.Provider, userAgent string) *EvermeSync {
	if cred == nil {
		return nil
	}
	return &EvermeSync{
		apiBaseURL: apiBaseURL,
		cred:       cred,
		http:       &http.Client{Timeout: 15 * time.Second},
		ua:         userAgent,
	}
}

// RecordInstall notifies the everme backend that a skill was installed.
// Runs synchronously so the CLI process does not exit before the request completes.
// Errors are swallowed — local install already succeeded.
func (s *EvermeSync) RecordInstall(r InstallRecord) {
	if s == nil {
		return
	}
	s.post(context.Background(), "/api/v1/skills/installs", r)
}

// RecordRemove marks connect_local_agent=false on the everme backend.
// Runs synchronously so the CLI process does not exit before the request completes.
func (s *EvermeSync) RecordRemove(skillID string) {
	if s == nil {
		return
	}
	s.patch(context.Background(), "/api/v1/skills/installs", map[string]any{
		"skillId":           skillID,
		"connectLocalAgent": false,
	})
}

func (s *EvermeSync) post(ctx context.Context, path string, body any) {
	if err := s.do(ctx, http.MethodPost, path, body); err != nil {
		logger.L().Warnw("everme skill sync failed", "method", "POST", "path", path, "err", err)
	}
}

func (s *EvermeSync) patch(ctx context.Context, path string, body any) {
	if err := s.do(ctx, http.MethodPatch, path, body); err != nil {
		logger.L().Warnw("everme skill sync failed", "method", "PATCH", "path", path, "err", err)
	}
}

func (s *EvermeSync) do(ctx context.Context, method, path string, body any) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	emk, err := s.cred.Get(ctx, credential.APIKey())
	if err != nil {
		return fmt.Errorf("read credential: %w", err)
	}

	var bodyReader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal body: %w", err)
		}
		bodyReader = bytes.NewReader(raw)
	}

	req, err := http.NewRequestWithContext(ctx, method, s.apiBaseURL+path, bodyReader)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+emk)
	req.Header.Set("User-Agent", s.ua)
	if bodyReader != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := s.http.Do(req)
	if err != nil {
		return output.Network(s.apiBaseURL, err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body) //nolint:errcheck
	return nil
}
