package conversation

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// Uploader writes a Conversation to the BFF agent-memory endpoint using a
// caller-supplied target-platform evt. It is local (does NOT use the shared
// client, which hardcodes evercli's evt). All batches are sent with sync:true
// so leading batches are applied before the final one is processed; only the
// last batch of a session sets flush:true, which requests extraction over the
// whole session once every prior batch has landed.
type Uploader struct {
	baseURL string
	hc      *http.Client
	// maxBatchBytes bounds a single POST; a session larger than this is split
	// into multiple add calls under the same conversationId (EverOS rejects
	// oversized agent payloads). 0 falls back to maxAgentBatchBytes.
	maxBatchBytes int
}

func NewUploader(baseURL string, hc *http.Client) *Uploader {
	if hc == nil {
		hc = http.DefaultClient
	}
	return &Uploader{baseURL: baseURL, hc: hc, maxBatchBytes: maxAgentBatchBytes}
}

type agentMemoryReq struct {
	ConversationID string               `json:"conversationId"`
	Messages       []AgentMemoryMessage `json:"messages"`
	Flush          bool                 `json:"flush"`
	// Sync forces the synchronous add path on leading batches so the final
	// flushing batch can see every earlier batch (v1.AgentMemoryRequest.Sync).
	Sync bool `json:"sync,omitempty"`
}

// Upload POSTs the conversation; returns the upstream status string
// (queued/accepted/success/...). Any 2xx counts as "submitted". A session
// whose messages exceed maxBatchBytes is split into multiple add calls under
// the same conversationId (EverOS rejects oversized agent payloads). All
// batches must succeed; the status of the last batch is returned. A mid-way
// failure leaves earlier batches submitted — a retry re-sends the whole
// session (the server is not idempotent), same as the single-POST path.
func (u *Uploader) Upload(ctx context.Context, targetEvt string, conv *Conversation) (string, error) {
	batches := batchMessagesByBytes(conv.Messages, u.maxBatchBytes)
	if len(batches) == 0 {
		return "", fmt.Errorf("conversation %s has no messages to upload", conv.ID)
	}
	var status string
	for i, batch := range batches {
		final := i == len(batches)-1
		s, err := u.postBatch(ctx, targetEvt, conv.ID, batch, final, true)
		if err != nil {
			if len(batches) > 1 {
				return "", fmt.Errorf("batch %d/%d: %w", i+1, len(batches), err)
			}
			return "", err
		}
		status = s
	}
	return status, nil
}

// UploadAsync POSTs the conversation without sync or flush on any batch: the
// server ACKs each add as enqueued ("queued") instead of waiting for the
// upstream write. It deliberately does NOT flush the tail batch — a flush
// racing an async add that has not landed upstream silently drops the batch
// from extraction (the failure the sync path exists to avoid). Callers issue
// the flush later via FlushSession, after the adds have had time to land.
// Batching, ordering, and mid-way failure semantics match Upload.
func (u *Uploader) UploadAsync(ctx context.Context, targetEvt string, conv *Conversation) (string, error) {
	batches := batchMessagesByBytes(conv.Messages, u.maxBatchBytes)
	if len(batches) == 0 {
		return "", fmt.Errorf("conversation %s has no messages to upload", conv.ID)
	}
	var status string
	for i, batch := range batches {
		s, err := u.postBatch(ctx, targetEvt, conv.ID, batch, false, false)
		if err != nil {
			if len(batches) > 1 {
				return "", fmt.Errorf("batch %d/%d: %w", i+1, len(batches), err)
			}
			return "", err
		}
		status = s
	}
	return status, nil
}

// FlushSession POSTs a flush-only request (no messages) for the session,
// asking the server to trigger extraction over everything already added
// under the conversation id. Returns the upstream flush status
// (extracted/no_extraction/...).
func (u *Uploader) FlushSession(ctx context.Context, targetEvt, conversationID string) (string, error) {
	return u.postBatch(ctx, targetEvt, conversationID, nil, true, false)
}

func (u *Uploader) postBatch(ctx context.Context, targetEvt, conversationID string, messages []AgentMemoryMessage, flush, sync bool) (string, error) {
	body, err := json.Marshal(agentMemoryReq{ConversationID: conversationID, Messages: messages, Flush: flush, Sync: sync})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.baseURL+"/api/v1/mem/agent-memory", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+targetEvt)
	resp, err := u.hc.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet := Redact(strings.TrimSpace(string(raw)))
		return "", fmt.Errorf("agent-memory POST %d: %s", resp.StatusCode, snippet)
	}
	// The BFF wraps success data under "result"; the root "status" is an
	// integer errno (0 = ok), not the async status. The agent-memory result
	// carries the real status (e.g. "queued"). See server/pkg/core/core.go
	// and v1.AgentMemoryResponse.
	var out struct {
		Result struct {
			Status  string `json:"status"`
			Flushed bool   `json:"flushed"`
		} `json:"result"`
	}
	_ = json.Unmarshal(raw, &out)
	status := out.Result.Status
	if status == "" {
		if out.Result.Flushed {
			status = "flushed"
		} else {
			status = "submitted" // POST accepted; server status absent/unexpected shape
		}
	}
	return status, nil
}
