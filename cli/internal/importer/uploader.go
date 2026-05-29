package importer

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"sort"
	"strings"
	"time"

	"evercli/internal/client"
	"evercli/internal/output"
)

// MaxMergedBytes is the hard ceiling for the merged-document size that
// the uploader is willing to push to S3. postMultipart serialises the
// whole payload into a bytes.Buffer to satisfy S3's Content-Length
// requirement, so peak memory is ~2× the merged size. Typical
// cold-start dumps are <2 MiB; 32 MiB gives a comfortable margin
// without letting a runaway batch pin ~512 MiB of CLI RAM.
const MaxMergedBytes int64 = 32 << 20

// Uploader wraps the three upload steps (presign, S3 POST, CreateRecord)
// and provides knobs for tests (custom http.Client). Production uses
// http.DefaultClient with sane timeouts.
type Uploader struct {
	cli  client.Client
	http *http.Client
}

// NewUploader returns a default Uploader. Caller passes the EverMe
// client; the underlying *http.Client is built with a 120s timeout
// matching the EverMe import upload contract.
func NewUploader(cli client.Client) *Uploader {
	return &Uploader{
		cli:  cli,
		http: &http.Client{Timeout: 120 * time.Second},
	}
}

// NewUploaderWithHTTP is the test-friendly variant that lets the
// httptest server's own client be threaded through (so the upload URL
// resolves to the in-process mock).
func NewUploaderWithHTTP(cli client.Client, hc *http.Client) *Uploader {
	return &Uploader{cli: cli, http: hc}
}

// UploadParams glues together everything Upload needs from the caller.
type UploadParams struct {
	Doc      *MergedDoc
	SourceID string // backend source id; empty → backend routes by default
	APIBase  string // baseURL for record + presign request labelling
}

// Upload runs the three-step pipeline and returns the resulting
// RecordResult on success. Idempotency-conflict on CreateRecord is
// retried once with a fresh key (per 05-import.md §5.2.3).
//
// Side-effects on the supplied checkpoint:
//   - filled with presign output (step="presigned") before S3 POST
//   - advanced to step="uploaded" after S3 POST
//   - left at "uploaded" if CreateRecord fails (so --resume can retry)
//   - caller deletes the checkpoint on success
func (u *Uploader) Upload(ctx context.Context, p UploadParams, ck *Checkpoint) (*RecordResult, error) {
	if p.Doc == nil {
		return nil, output.Internal(fmt.Errorf("nil merged doc"))
	}
	if p.Doc.SizeBytes > MaxMergedBytes {
		return nil, output.Invalid(
			fmt.Sprintf("merged document is %d bytes, exceeds local cap %d", p.Doc.SizeBytes, MaxMergedBytes),
			"Split the import into smaller batches or raise MaxMergedBytes if you really need this size",
		)
	}

	// Step 1: presign — unless checkpoint already has it.
	if ck.UploadURL == "" || !ck.UploadURLValid(time.Now()) {
		presign, err := u.cli.Presign(ctx, client.PresignReq{
			FileName:    p.Doc.FileName,
			ContentType: "text/markdown",
			SizeBytes:   p.Doc.SizeBytes,
			ContentHash: p.Doc.ContentHash,
		})
		if err != nil {
			return nil, err
		}
		// Backend returns expiresAt as RFC3339 string — parse defensively.
		// Empty / unparsable → leave zero so UploadURLValid() returns
		// false and we re-presign on next attempt.
		var expires time.Time
		if presign.ExpiresAt != "" {
			expires, _ = time.Parse(time.RFC3339, presign.ExpiresAt)
		}
		ck.Platform = p.Doc.Platform
		ck.Step = "presigned"
		ck.IdempotencyKey = p.Doc.IdempotencyKey
		ck.DocumentKey = p.Doc.DocumentKey
		ck.ContentHash = p.Doc.ContentHash
		ck.SizeBytes = p.Doc.SizeBytes
		ck.FileCount = p.Doc.FileCount
		ck.SourceID = p.SourceID
		ck.ObjectKey = presign.ObjectKey
		ck.UploadURL = presign.UploadURL
		ck.UploadFields = presign.FormFields
		ck.UploadURLExpiresAt = expires
		ck.CreatedAt = time.Now().UTC()
	}

	// Step 2: S3 POST. Skip if step is already past "presigned".
	if ck.Step != "uploaded" {
		if err := u.postMultipart(ctx, ck.UploadURL, ck.UploadFields, p.Doc.Body, p.Doc.FileName); err != nil {
			return nil, err
		}
		ck.Step = "uploaded"
	}

	// Step 3: CreateRecord. Idempotency-conflict triggers one
	// fresh-key retry.
	rec, err := u.createRecordWithRetry(ctx, p, ck)
	if err != nil {
		return nil, err
	}
	ck.Step = "recorded"

	return &RecordResult{
		Platform:       p.Doc.Platform,
		RecordID:       rec.ID,
		SourceID:       p.SourceID,
		ObjectKey:      ck.ObjectKey,
		FileCount:      p.Doc.FileCount,
		TotalBytes:     p.Doc.SizeBytes,
		MergedBytes:    p.Doc.SizeBytes,
		ContentHash:    p.Doc.ContentHash,
		DocumentKey:    p.Doc.DocumentKey,
		IdempotencyKey: ck.IdempotencyKey,
	}, nil
}

func (u *Uploader) createRecordWithRetry(ctx context.Context, p UploadParams, ck *Checkpoint) (*client.CreateRecordResp, error) {
	// Title is required by the backend's CreateRecordRequest binding.
	// Build a deterministic, human-readable label per platform so the
	// Web UI shows something meaningful for cold-start records.
	title := "Cold-start memory · " + string(p.Doc.Platform)
	req := client.CreateRecordReq{
		ObjectKey:   ck.ObjectKey,
		Title:       title,
		SizeBytes:   p.Doc.SizeBytes,
		ContentHash: p.Doc.ContentHash,
		ContentType: "text/markdown",
		RawFormat:   "markdown",
		Tags:        []string{"cold-start", string(p.Doc.Platform)},
		Metadata: map[string]interface{}{
			"fileCount": p.Doc.FileCount,
			"agent":     string(p.Doc.Platform),
		},
		DocumentKey:    p.Doc.DocumentKey,
		IdempotencyKey: ck.IdempotencyKey,
		// Cold-start imports re-attribute to the target AI platform so
		// they show under Claude Code / OpenClaw / etc. in the UI, not
		// under EverCli (the write-channel agent). Server defaults to
		// agent.Platform when this is absent, which would surface as
		// "EverCli" — explicitly override here.
		OriginPlatform: string(p.Doc.Platform),
	}
	rec, err := u.cli.CreateRecord(ctx, req)
	if err == nil {
		return rec, nil
	}

	// Auto-retry on idempotency-conflict — backend reuses an in-flight
	// row keyed by idempotencyKey, but a same-millisecond collision
	// means we should mint a fresh key and try once more (05 §5.2.3).
	ce, ok := output.AsCLIError(err)
	if !ok || !isIdempotencyConflict(ce) {
		return nil, err
	}

	freshKey := newIdempotencyKey()
	ck.IdempotencyKey = freshKey
	req.IdempotencyKey = freshKey
	rec2, err2 := u.cli.CreateRecord(ctx, req)
	if err2 != nil {
		// Wrap so the user sees we already retried — second failure is
		// genuinely uncommon, so the hint steers toward investigation
		// rather than another retry of our own.
		ce2, ok := output.AsCLIError(err2)
		if ok {
			ce2.Hint = "Both the initial attempt and a fresh-key retry failed; rerun `evercli import run` to mint another key, or check the requestId in EverMe support"
		}
		return nil, err2
	}
	return rec2, nil
}

// isIdempotencyConflict matches both backend conflict flavors:
//   - explicit TypeConflict surface
//   - upstream errno where the message mentions "Idempotency"
//     (defensive: backend may classify these as upstream rather than
//     conflict depending on errno-range mapping)
func isIdempotencyConflict(ce *output.CLIError) bool {
	if ce.Type == output.TypeConflict {
		return true
	}
	return ce.Type == output.TypeUpstream && strings.Contains(ce.Message, "Idempotency")
}

// postMultipart implements the AWS S3 Presigned POST protocol with two
// invariants:
//
//  1. Field order is deterministic. AWS S3 rejects PresignedPOST when
//     the policy / x-amz-* fields appear after the `file` field in the
//     multipart body — Go's map iteration is intentionally random, so
//     ranging over `fields` produced occasional InvalidPolicyDocument
//     failures depending on which way the runtime shuffled. We sort
//     the keys with `policy` and `x-amz-*` first so the file is always
//     last.
//
//  2. Content-Length is set. S3 rejects PresignedPOST without a
//     Content-Length header (411 MissingContentLength) — chunked
//     transfer encoding is not accepted. We serialise the whole body
//     into a bytes.Buffer up front so net/http auto-fills it.
//     MaxMergedBytes (32 MiB) bounds peak RAM at ~2× that.
func (u *Uploader) postMultipart(ctx context.Context, uploadURL string, fields map[string]string, body []byte, fileName string) error {
	if uploadURL == "" {
		return output.Internal(errors.New("empty uploadUrl"))
	}

	keys := orderedFormFieldKeys(fields)
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for _, k := range keys {
		if err := mw.WriteField(k, fields[k]); err != nil {
			return output.Internal(fmt.Errorf("multipart field %s: %w", k, err))
		}
	}
	fw, err := mw.CreateFormFile("file", fileName)
	if err != nil {
		return output.Internal(fmt.Errorf("multipart file: %w", err))
	}
	if _, err := fw.Write(body); err != nil {
		return output.Internal(fmt.Errorf("multipart body: %w", err))
	}
	if err := mw.Close(); err != nil {
		return output.Internal(fmt.Errorf("multipart close: %w", err))
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, uploadURL, &buf)
	if err != nil {
		return output.Internal(fmt.Errorf("build s3 request: %w", err))
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := u.http.Do(req)
	if err != nil {
		host := ""
		if req.URL != nil {
			host = req.URL.Host
		}
		return output.Network(host, fmt.Errorf("s3 post: %w", err))
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	}
	// 4xx from S3 means the policy rejected us — usually size mismatch.
	const maxS3ErrBytes = 8 << 10
	bodyText, _ := io.ReadAll(io.LimitReader(resp.Body, maxS3ErrBytes))
	return output.Upstream(resp.StatusCode, "S3 upload rejected: "+truncate(string(bodyText), 200), "")
}

// orderedFormFieldKeys sorts the presign field map so the policy /
// signature fields are emitted before any user-data field and the
// `file` field is last (S3 requirement). Within each bucket we sort
// lexically so the order is reproducible across runs.
func orderedFormFieldKeys(fields map[string]string) []string {
	policy := []string{}
	other := []string{}
	for k := range fields {
		if k == "policy" || strings.HasPrefix(k, "x-amz-") || strings.HasPrefix(k, "X-Amz-") {
			policy = append(policy, k)
		} else {
			other = append(other, k)
		}
	}
	sort.Strings(policy)
	sort.Strings(other)
	return append(policy, other...)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
