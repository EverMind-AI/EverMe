package importer

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"evercli/internal/client"
	"evercli/internal/core"
	"evercli/internal/credential"
	"evercli/internal/httpmock"
	"evercli/internal/output"
)

// stubScanner walks a tmp directory we control. Lets tests pin the
// scan root without touching $HOME or env vars.
type stubScanner struct {
	platform PlatformID
	root     string
}

func (s stubScanner) Platform() PlatformID  { return s.platform }
func (s stubScanner) Root() (string, error) { return s.root, nil }
func (s stubScanner) Scan(ctx context.Context, ex []string) (*SourceScan, error) {
	return scanMarkdownTree(ctx, s.platform, s.root, ex)
}

// ---- scanner --------------------------------------------------------

func TestScan_EmptyRoot_NotAnError(t *testing.T) {
	tmp := t.TempDir()
	s := stubScanner{platform: PlatformClaudeCode, root: tmp}
	res, err := s.Scan(context.Background(), nil)
	require.NoError(t, err)
	assert.Empty(t, res.Files)
	assert.Zero(t, res.TotalBytes)
}

func TestScan_MissingRoot_NotAnError(t *testing.T) {
	s := stubScanner{platform: PlatformClaudeCode, root: "/tmp/definitely-does-not-exist-xyz-12345"}
	res, err := s.Scan(context.Background(), nil)
	require.NoError(t, err)
	assert.Empty(t, res.Files)
}

func TestScan_PicksUpMarkdown_SortsByRelPath(t *testing.T) {
	tmp := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(tmp, "z.md"), []byte("zz"), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(tmp, "a.md"), []byte("aa"), 0o600))
	require.NoError(t, os.MkdirAll(filepath.Join(tmp, "sub"), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(tmp, "sub", "m.md"), []byte("mm"), 0o600))

	s := stubScanner{platform: PlatformClaudeCode, root: tmp}
	res, err := s.Scan(context.Background(), nil)
	require.NoError(t, err)
	require.Len(t, res.Files, 3)
	assert.Equal(t, "a.md", res.Files[0].RelPath)
	assert.Equal(t, "sub/m.md", filepath.ToSlash(res.Files[1].RelPath))
	assert.Equal(t, "z.md", res.Files[2].RelPath)
	assert.EqualValues(t, 6, res.TotalBytes)
}

func TestScan_SkipsBlacklistedDirs(t *testing.T) {
	tmp := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(tmp, ".git"), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(tmp, ".git", "HEAD.md"), []byte("ref"), 0o600))
	require.NoError(t, os.MkdirAll(filepath.Join(tmp, "node_modules"), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(tmp, "node_modules", "x.md"), []byte("y"), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(tmp, "real.md"), []byte("hello"), 0o600))

	s := stubScanner{platform: PlatformClaudeCode, root: tmp}
	res, err := s.Scan(context.Background(), nil)
	require.NoError(t, err)
	require.Len(t, res.Files, 1)
	assert.Equal(t, "real.md", res.Files[0].RelPath)
}

func TestScan_LargeFilesSkipped(t *testing.T) {
	tmp := t.TempDir()
	big := make([]byte, SingleFileLimitBytes+10)
	require.NoError(t, os.WriteFile(filepath.Join(tmp, "big.md"), big, 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(tmp, "small.md"), []byte("ok"), 0o600))

	s := stubScanner{platform: PlatformClaudeCode, root: tmp}
	res, err := s.Scan(context.Background(), nil)
	require.NoError(t, err)
	require.Len(t, res.Files, 1)
	assert.Equal(t, "small.md", res.Files[0].RelPath)
	require.Len(t, res.SkippedFiles, 1)
	assert.Contains(t, res.SkippedFiles[0].Reason, "too large")
}

// ---- merger ---------------------------------------------------------

func TestMerge_DocumentKeyStableAcrossInstances(t *testing.T) {
	tmp := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(tmp, "a.md"), []byte("hello"), 0o600))

	s := stubScanner{platform: PlatformClaudeCode, root: tmp}
	scan, _ := s.Scan(context.Background(), nil)

	m1, err := Merge(scan, MergeOptions{SourceID: "src_x", Now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)})
	require.NoError(t, err)
	m2, err := Merge(scan, MergeOptions{SourceID: "src_x", Now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)})
	require.NoError(t, err)

	assert.Equal(t, m1.DocumentKey, m2.DocumentKey, "documentKey must depend only on (sourceKey, platform)")
	assert.NotEqual(t, m1.IdempotencyKey, m2.IdempotencyKey, "idempotencyKey must be fresh per call")
}

func TestMerge_ContentHashStable_NotAffectedByLineEndings(t *testing.T) {
	tmp := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(tmp, "a.md"), []byte("line1\nline2\n"), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(tmp, "b.md"), []byte("line1\r\nline2\r\n"), 0o600))

	scan := &SourceScan{
		Platform: PlatformClaudeCode,
		Files: []ScanFile{
			{Path: filepath.Join(tmp, "a.md"), RelPath: "a.md", SizeBytes: 12},
			{Path: filepath.Join(tmp, "b.md"), RelPath: "b.md", SizeBytes: 14},
		},
	}
	merged, err := Merge(scan, MergeOptions{Now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)})
	require.NoError(t, err)
	// Both files should appear with identical normalized content.
	count := strings.Count(string(merged.Body), "line1\nline2\n")
	assert.Equal(t, 2, count, "CRLF must be normalized to LF before merge")
}

func TestMerge_FailsOnEmptyScan(t *testing.T) {
	_, err := Merge(&SourceScan{Platform: PlatformClaudeCode}, MergeOptions{})
	require.Error(t, err)
	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Equal(t, output.TypeInvalidArgs, ce.Type)
}

// ---- uploader -------------------------------------------------------

// s3Server is a tiny fake of the AWS S3 PresignedPOST endpoint. Returns
// 204 on POST, recording received bytes.
type s3Server struct {
	*httptest.Server
	receivedFile   []byte
	receivedFields map[string]string
	failOnPost     bool
}

func newS3Server(t *testing.T, fail bool) *s3Server {
	t.Helper()
	s := &s3Server{failOnPost: fail, receivedFields: map[string]string{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/s3-upload", func(w http.ResponseWriter, r *http.Request) {
		if s.failOnPost {
			http.Error(w, "policy denied", http.StatusForbidden)
			return
		}
		err := r.ParseMultipartForm(32 << 20)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		for k, v := range r.MultipartForm.Value {
			if len(v) > 0 {
				s.receivedFields[k] = v[0]
			}
		}
		fhs := r.MultipartForm.File["file"]
		if len(fhs) > 0 {
			f, err := fhs[0].Open()
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			defer f.Close()
			buf := make([]byte, fhs[0].Size)
			_, _ = f.Read(buf)
			s.receivedFile = buf
		}
		w.WriteHeader(204)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	s.Server = srv
	return s
}

func TestUpload_HappyPath(t *testing.T) {
	srv := httpmock.NewServer(t)
	mem := credential.NewMem()
	require.NoError(t, mem.Set(context.Background(), credential.APIKey(),
		"emk_0123456789abcdef0123456789abcdef"))
	require.NoError(t, mem.Set(context.Background(), credential.AgentToken(),
		"evt_0123456789abcdef0123456789abcdef"))
	cli := client.NewWithHTTP(srv.URL(), mem, srv.HTTPClient())

	s3 := newS3Server(t, false)
	uploader := NewUploaderWithHTTP(cli, srv.HTTPClient())

	srv.HandleEnvelope("POST /mem/uploads/presign", client.PresignResp{
		UploadURL:  s3.URL + "/s3-upload",
		FormFields: map[string]string{"key": "objects/x", "policy": "..."},
		ObjectKey:  "objects/x",
		ExpiresAt:  time.Now().Add(time.Hour).Format(time.RFC3339),
	})
	srv.HandleEnvelope("POST /mem/sources", client.CreateRecordResp{
		ID:        "rec_xyz",
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	})

	doc := &MergedDoc{
		Platform: PlatformClaudeCode, FileName: "merge.md",
		Body: []byte("hello world"), SizeBytes: 11,
		ContentHash: "h", FileCount: 1,
		DocumentKey: "doc_x", IdempotencyKey: "idem_x",
	}
	res, err := uploader.Upload(context.Background(), UploadParams{Doc: doc, SourceID: "src_x"}, &Checkpoint{})
	require.NoError(t, err)
	assert.Equal(t, "rec_xyz", res.RecordID)
	assert.Equal(t, "objects/x", res.ObjectKey)
	assert.Equal(t, "hello world", string(s3.receivedFile))
	assert.Equal(t, "objects/x", s3.receivedFields["key"])
}

// TestUpload_SendsOriginPlatform asserts the CLI explicitly sets
// originPlatform on POST /mem/sources matching the target platform.
// Without this, evercli imports would default server-side to the
// caller's own platform (evercli) — surfacing cold-start data as
// "EverCli" rather than the AI agent it actually belongs to.
func TestUpload_SendsOriginPlatform(t *testing.T) {
	srv := httpmock.NewServer(t)
	mem := credential.NewMem()
	require.NoError(t, mem.Set(context.Background(), credential.APIKey(),
		"emk_0123456789abcdef0123456789abcdef"))
	require.NoError(t, mem.Set(context.Background(), credential.AgentToken(),
		"evt_0123456789abcdef0123456789abcdef"))
	cli := client.NewWithHTTP(srv.URL(), mem, srv.HTTPClient())

	s3 := newS3Server(t, false)
	uploader := NewUploaderWithHTTP(cli, srv.HTTPClient())

	srv.HandleEnvelope("POST /mem/uploads/presign", client.PresignResp{
		UploadURL:  s3.URL + "/s3-upload",
		FormFields: map[string]string{"key": "objects/x"},
		ObjectKey:  "objects/x",
		ExpiresAt:  time.Now().Add(time.Hour).Format(time.RFC3339),
	})

	srv.HandleEnvelope("POST /mem/sources", client.CreateRecordResp{
		ID: "rec_o", CreatedAt: time.Now().UTC().Format(time.RFC3339),
	})

	doc := &MergedDoc{
		Platform: PlatformClaudeCode, FileName: "x.md",
		Body: []byte("body"), SizeBytes: 4,
		ContentHash: "h", FileCount: 1,
		DocumentKey: "doc_x", IdempotencyKey: "idem_x",
	}
	_, err := uploader.Upload(context.Background(), UploadParams{Doc: doc}, &Checkpoint{})
	require.NoError(t, err, "upload should succeed end-to-end")

	recorded := srv.LastRequest("POST /mem/sources")
	require.NotNil(t, recorded, "POST /mem/sources must have been called")
	var sent map[string]any
	require.NoError(t, json.Unmarshal(recorded.Body, &sent))
	assert.Equal(t, "claude-code", sent["originPlatform"],
		"importer must set originPlatform = target platform string (matches PlatformClaudeCode)")
}

func TestUpload_S3Failure_BecomesUpstream(t *testing.T) {
	srv := httpmock.NewServer(t)
	mem := credential.NewMem()
	require.NoError(t, mem.Set(context.Background(), credential.APIKey(),
		"emk_0123456789abcdef0123456789abcdef"))
	require.NoError(t, mem.Set(context.Background(), credential.AgentToken(),
		"evt_0123456789abcdef0123456789abcdef"))
	cli := client.NewWithHTTP(srv.URL(), mem, srv.HTTPClient())
	s3 := newS3Server(t, true)

	uploader := NewUploaderWithHTTP(cli, srv.HTTPClient())
	srv.HandleEnvelope("POST /mem/uploads/presign", client.PresignResp{
		UploadURL:  s3.URL + "/s3-upload",
		FormFields: map[string]string{"key": "objects/x"},
		ObjectKey:  "objects/x",
		ExpiresAt:  time.Now().Add(time.Hour).Format(time.RFC3339),
	})

	doc := &MergedDoc{
		Platform: PlatformClaudeCode, FileName: "x.md",
		Body: []byte("body"), SizeBytes: 4,
		ContentHash: "h", FileCount: 1,
		DocumentKey: "doc_x", IdempotencyKey: "idem_x",
	}
	_, err := uploader.Upload(context.Background(), UploadParams{Doc: doc}, &Checkpoint{})
	require.Error(t, err)
	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Equal(t, output.TypeUpstream, ce.Type)
	assert.Equal(t, 403, ce.Code)
}

func TestUpload_IdempotencyConflict_RetriesOnceWithFreshKey(t *testing.T) {
	srv := httpmock.NewServer(t)
	mem := credential.NewMem()
	require.NoError(t, mem.Set(context.Background(), credential.APIKey(),
		"emk_0123456789abcdef0123456789abcdef"))
	require.NoError(t, mem.Set(context.Background(), credential.AgentToken(),
		"evt_0123456789abcdef0123456789abcdef"))
	cli := client.NewWithHTTP(srv.URL(), mem, srv.HTTPClient())
	s3 := newS3Server(t, false)

	srv.HandleEnvelope("POST /mem/uploads/presign", client.PresignResp{
		UploadURL:  s3.URL + "/s3-upload",
		FormFields: map[string]string{"key": "objects/x"},
		ObjectKey:  "objects/x",
		ExpiresAt:  time.Now().Add(time.Hour).Format(time.RFC3339),
	})

	// Replay-style: first /mem/records call returns idempotency conflict;
	// second succeeds.
	calls := 0
	srv.Handle("POST /mem/sources", func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		if calls == 1 {
			_, _ = w.Write([]byte(`{"status":40005,"error":"ErrIdempotencyConflict","requestId":"r"}`))
			return
		}
		_, _ = w.Write([]byte(`{"status":0,"requestId":"r","result":{"id":"rec_yy","createdAt":"2026-01-01T00:00:00Z"}}`))
	})

	uploader := NewUploaderWithHTTP(cli, srv.HTTPClient())
	doc := &MergedDoc{
		Platform: PlatformClaudeCode, FileName: "x.md",
		Body: []byte("body"), SizeBytes: 4,
		ContentHash: "h", FileCount: 1,
		DocumentKey: "doc_x", IdempotencyKey: "idem_orig",
	}

	res, err := uploader.Upload(context.Background(), UploadParams{Doc: doc}, &Checkpoint{})
	require.NoError(t, err)
	assert.Equal(t, "rec_yy", res.RecordID)
	assert.Equal(t, 2, calls, "must retry exactly once on idempotency conflict")
	assert.NotEqual(t, "idem_orig", res.IdempotencyKey, "retry must mint a fresh idempotency key")
}

// ---- service --------------------------------------------------------

func newServiceFixture(t *testing.T, platform PlatformID, scanRoot string) (*httpmock.Server, *Service, string) {
	t.Helper()
	srv := httpmock.NewServer(t)
	mem := credential.NewMem()
	require.NoError(t, mem.Set(context.Background(), credential.APIKey(),
		"emk_0123456789abcdef0123456789abcdef"))
	require.NoError(t, mem.Set(context.Background(), credential.AgentToken(),
		"evt_0123456789abcdef0123456789abcdef"))
	cli := client.NewWithHTTP(srv.URL(), mem, srv.HTTPClient())

	cacheDir := t.TempDir()
	paths := &core.Paths{ConfigDir: cacheDir, DataDir: cacheDir, CacheDir: cacheDir}

	svc := NewService(cli, paths, "https://api.test")
	svc.SetScanners([]Scanner{stubScanner{platform: platform, root: scanRoot}})
	svc.SetUploadHTTPClient(srv.HTTPClient())
	return srv, svc, cacheDir
}

func TestRun_DryRun_ProducesPreviewNoBackend(t *testing.T) {
	tmp := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(tmp, "a.md"), []byte("hello"), 0o600))

	srv, svc, _ := newServiceFixture(t, PlatformClaudeCode, tmp)

	rep, err := svc.Run(context.Background(), RunOptions{DryRun: true})
	require.NoError(t, err)
	require.True(t, rep.DryRun)
	require.Len(t, rep.Previews, 1)
	assert.Equal(t, 1, rep.Previews[0].FileCount)
	assert.Empty(t, rep.Imports)

	assert.Nil(t, srv.LastRequest("POST /mem/uploads/presign"), "--dry-run must not call presign")
}

func TestRun_NoFiles_Skipped(t *testing.T) {
	tmp := t.TempDir()
	_, svc, _ := newServiceFixture(t, PlatformClaudeCode, tmp)

	rep, err := svc.Run(context.Background(), RunOptions{})
	require.NoError(t, err)
	require.Len(t, rep.Skipped, 1)
	assert.Equal(t, "no files", rep.Skipped[0].Reason)
}

func TestRun_HappyEndToEnd_PersistsThenDeletesCheckpoint(t *testing.T) {
	tmp := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(tmp, "a.md"), []byte("hello"), 0o600))

	srv, svc, cache := newServiceFixture(t, PlatformClaudeCode, tmp)
	s3 := newS3Server(t, false)
	srv.HandleEnvelope("POST /mem/uploads/presign", client.PresignResp{
		UploadURL:  s3.URL + "/s3-upload",
		FormFields: map[string]string{"key": "objects/x"},
		ObjectKey:  "objects/x",
		ExpiresAt:  time.Now().Add(time.Hour).Format(time.RFC3339),
	})
	srv.HandleEnvelope("POST /mem/sources", client.CreateRecordResp{ID: "rec_x"})

	rep, err := svc.Run(context.Background(), RunOptions{})
	require.NoError(t, err)
	require.Len(t, rep.Imports, 1)
	assert.Equal(t, "rec_x", rep.Imports[0].RecordID)

	// On success the checkpoint file must be cleaned up.
	_, statErr := os.Stat(CheckpointPath(cache, PlatformClaudeCode))
	assert.True(t, os.IsNotExist(statErr), "checkpoint must be removed after recorded step")
}

func TestRun_S3FailureLeavesCheckpointForResume(t *testing.T) {
	tmp := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(tmp, "a.md"), []byte("hello"), 0o600))

	srv, svc, cache := newServiceFixture(t, PlatformClaudeCode, tmp)
	s3 := newS3Server(t, true) // S3 returns 403
	srv.HandleEnvelope("POST /mem/uploads/presign", client.PresignResp{
		UploadURL:  s3.URL + "/s3-upload",
		FormFields: map[string]string{"key": "objects/x"},
		ObjectKey:  "objects/x",
		ExpiresAt:  time.Now().Add(time.Hour).Format(time.RFC3339),
	})

	rep, err := svc.Run(context.Background(), RunOptions{})
	require.NoError(t, err)
	require.Len(t, rep.Failed, 1)
	assert.Equal(t, output.TypeUpstream, rep.Failed[0].Error.Type)

	// Checkpoint should be on disk so --resume can pick it up.
	ck, err := LoadCheckpoint(CheckpointPath(cache, PlatformClaudeCode))
	require.NoError(t, err)
	require.NotNil(t, ck, "checkpoint must be persisted on partial failure")
	assert.Equal(t, "presigned", ck.Step)
}

func TestRun_UnknownPlatform_InvalidArgs(t *testing.T) {
	tmp := t.TempDir()
	_, svc, _ := newServiceFixture(t, PlatformClaudeCode, tmp)
	_, err := svc.Run(context.Background(), RunOptions{Platforms: []PlatformID{"nope"}})
	require.Error(t, err)
	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Equal(t, output.TypeInvalidArgs, ce.Type)
}
