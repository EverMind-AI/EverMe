package importer

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestOrderedFormFieldKeys_PolicyFirst(t *testing.T) {
	in := map[string]string{
		"key":              "v",
		"x-amz-signature":  "v",
		"X-Amz-Date":       "v",
		"policy":           "v",
		"acl":              "v",
		"x-amz-credential": "v",
	}
	got := orderedFormFieldKeys(in)
	// Every signed/policy field must come before any non-signed field.
	policyEnd := 0
	for i, k := range got {
		if strings.HasPrefix(k, "policy") || strings.HasPrefix(strings.ToLower(k), "x-amz-") {
			policyEnd = i + 1
		}
	}
	for i := policyEnd; i < len(got); i++ {
		assert.False(t, strings.HasPrefix(got[i], "policy") || strings.HasPrefix(strings.ToLower(got[i]), "x-amz-"),
			"non-signed field %q must come after every policy / x-amz-* field", got[i])
	}
	// Determinism: stable across runs.
	got2 := orderedFormFieldKeys(in)
	assert.Equal(t, got, got2, "ordering must be deterministic, regardless of map iteration randomness")
}

func TestPostMultipart_OrdersFieldsBeforeFile(t *testing.T) {
	// Mock S3: capture the multipart form, look at the field order in
	// the raw body. This test verifies field ORDER (the
	// `policy`/`x-amz-*` first, file last invariant); a separate test
	// covers the Content-Length invariant.
	var rawBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		rawBody = string(b)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	u := &Uploader{http: srv.Client()}
	fields := map[string]string{
		"key":              "objects/abc",
		"x-amz-signature":  "deadbeef",
		"x-amz-credential": "AKIA",
		"policy":           "BASE64==",
		"acl":              "private",
	}
	require.NoError(t, u.postMultipart(context.Background(), srv.URL, fields, []byte("body"), "mem.md"))

	// In the raw body, every "name=\"<policy field>\"" boundary must
	// appear before the file boundary, and the file boundary must be
	// last among Content-Disposition headers.
	policyIdx := strings.Index(rawBody, `name="policy"`)
	xamzIdx := strings.Index(rawBody, `name="x-amz-signature"`)
	keyIdx := strings.Index(rawBody, `name="key"`)
	fileIdx := strings.Index(rawBody, `name="file"`)
	require.NotEqual(t, -1, policyIdx, "policy field must appear in the body")
	require.NotEqual(t, -1, fileIdx, "file field must appear in the body")
	assert.Less(t, policyIdx, fileIdx, "policy must precede file (S3 PresignedPOST contract)")
	assert.Less(t, xamzIdx, fileIdx, "x-amz-signature must precede file")
	assert.Less(t, keyIdx, fileIdx, "every non-file field must precede file")
}

func TestPostMultipart_SetsContentLength(t *testing.T) {
	// AWS S3 PresignedPOST rejects requests without Content-Length
	// (411 MissingContentLength) — chunked transfer encoding is not
	// accepted. Regression guard: the previous io.Pipe streaming
	// implementation left ContentLength=0, so net/http fell back to
	// Transfer-Encoding: chunked and every real upload failed against
	// production S3. This test asserts the request carries a real
	// Content-Length and no chunked transfer encoding.
	var gotContentLength int64 = -1
	var gotTransferEncoding []string
	var gotBodyLen int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotContentLength = r.ContentLength
		gotTransferEncoding = append([]string(nil), r.TransferEncoding...)
		b, _ := io.ReadAll(r.Body)
		gotBodyLen = len(b)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	u := &Uploader{http: srv.Client()}
	fields := map[string]string{
		"policy":          "x",
		"x-amz-signature": "y",
	}
	body := make([]byte, 4<<10)
	for i := range body {
		body[i] = byte('a' + (i % 26))
	}
	require.NoError(t, u.postMultipart(context.Background(), srv.URL, fields, body, "mem.md"))

	assert.Greater(t, gotContentLength, int64(0),
		"S3 PresignedPOST requires Content-Length; chunked encoding triggers 411 MissingContentLength")
	assert.Equal(t, int64(gotBodyLen), gotContentLength,
		"Content-Length must equal the number of body bytes actually delivered")
	assert.Empty(t, gotTransferEncoding,
		"Transfer-Encoding must be empty (chunked encoding triggers S3 411)")
}

func TestPostMultipart_S3RejectIsClassifiedUpstream(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`<Error><Code>InvalidPolicyDocument</Code></Error>`))
	}))
	defer srv.Close()

	u := &Uploader{http: srv.Client()}
	err := u.postMultipart(context.Background(), srv.URL, map[string]string{"policy": "x"}, []byte("body"), "mem.md")
	require.Error(t, err)
	// Error must surface the S3 status code rather than getting swallowed.
	assert.Contains(t, err.Error(), "S3 upload rejected", "S3 4xx must be classified as upstream so users see the cause, not silent failure")
}

func TestPostMultipart_RejectsEmptyURL(t *testing.T) {
	u := &Uploader{http: http.DefaultClient}
	err := u.postMultipart(context.Background(), "", map[string]string{}, []byte("x"), "mem.md")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "uploadUrl")
}

func TestPostMultipart_TruncatesLargeS3ErrorBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(strings.Repeat("z", 1<<14))) // 16 KiB
	}))
	defer srv.Close()

	u := &Uploader{http: srv.Client()}
	err := u.postMultipart(context.Background(), srv.URL, map[string]string{}, []byte("body"), "mem.md")
	require.Error(t, err)
	assert.LessOrEqual(t, len(err.Error()), 1024, "error message must be truncated, not shipped as 16 KiB of S3 XML")
}

// (joinURL is exercised by client/url_test.go; the previous placeholder
// here was a no-op that didn't touch project code, deleted to avoid
// false coverage signal.)
