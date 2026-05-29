// Package httpmock provides a minimal in-process EverMe fake server for
// contract testing of internal/client. It is deliberately small — no
// recording, no expectations DSL — so tests stay readable.
//
// Usage:
//
//	srv := httpmock.NewServer(t)
//	srv.HandleEnvelope("POST /auth/login", LoginResp{...})
//	cli := client.NewWithHTTP(srv.URL(), credential.NewMem(), srv.HTTPClient())
//	resp, err := cli.Login(ctx, "emk_...")
package httpmock

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// Server wraps httptest.Server with EverMe envelope-shaped reply helpers.
type Server struct {
	t      *testing.T
	server *httptest.Server
	mux    *http.ServeMux

	// captured holds the most recent request per route so tests can
	// assert on headers / body without bookkeeping at the call site.
	mu       sync.Mutex
	captured map[string]*RecordedRequest
}

// RecordedRequest is a snapshot of an inbound request with the body
// pre-read into a byte slice — convenient for assertions.
type RecordedRequest struct {
	Method        string
	Path          string
	Header        http.Header
	Body          []byte
	Authorization string
}

// NewServer starts a server bound to a random localhost port. It is shut
// down via t.Cleanup, so callers don't need to defer Close themselves.
func NewServer(t *testing.T) *Server {
	t.Helper()
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return &Server{
		t:        t,
		server:   srv,
		mux:      mux,
		captured: map[string]*RecordedRequest{},
	}
}

// URL returns the base URL (no trailing slash) the test should pass to
// the client constructor.
func (s *Server) URL() string { return s.server.URL }

// HTTPClient returns the underlying httptest client. Use this with
// client.NewWithHTTP so requests follow the test transport.
func (s *Server) HTTPClient() *http.Client { return s.server.Client() }

// Handle registers a raw http.HandlerFunc for the given route. The
// route format matches Go 1.22+ http.ServeMux: "METHOD /path".
//
// The returned key is what tests pass to LastRequest. We snapshot the
// request body before invoking the handler so the handler is free to
// drain or replace r.Body.
func (s *Server) Handle(route string, fn http.HandlerFunc) {
	s.mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
		s.capture(route, r)
		fn(w, r)
	})
}

// HandleEnvelope is the most common helper: reply 200 with a successful
// envelope (status=0, requestId="req-mock") wrapping result.
func (s *Server) HandleEnvelope(route string, result interface{}) {
	s.Handle(route, func(w http.ResponseWriter, _ *http.Request) {
		writeEnvelope(s.t, w, 200, envelope{Status: 0, RequestID: "req-mock", Result: result})
	})
}

// HandleEnvelopeError replies with a non-zero envelope status. errno is
// the upstream code (e.g. 30202), msg is the symbolic error name.
func (s *Server) HandleEnvelopeError(route string, errno int, msg string) {
	s.Handle(route, func(w http.ResponseWriter, _ *http.Request) {
		writeEnvelope(s.t, w, 200, envelope{Status: errno, Error: msg, RequestID: "req-mock"})
	})
}

// HandleHTTPStatus replies with a raw HTTP status (no envelope). Use for
// 401 / 429 / 5xx scenarios where backend bypasses the envelope.
func (s *Server) HandleHTTPStatus(route string, status int, retryAfter string) {
	s.Handle(route, func(w http.ResponseWriter, _ *http.Request) {
		if retryAfter != "" {
			w.Header().Set("Retry-After", retryAfter)
		}
		w.WriteHeader(status)
	})
}

// LastRequest returns the most recent request captured for route, or nil
// if no request matched. Body is already drained.
func (s *Server) LastRequest(route string) *RecordedRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.captured[route]
}

func (s *Server) capture(route string, r *http.Request) {
	body, _ := readAll(r)
	// Restore r.Body so the user-provided handler can still read it —
	// the bare readAll above drained and closed the original. Handlers
	// that want to inspect the live request body (e.g. mirror server
	// filtering against the request payload) rely on this.
	r.Body = io.NopCloser(bytes.NewReader(body))
	recorded := &RecordedRequest{
		Method:        r.Method,
		Path:          r.URL.RequestURI(),
		Header:        r.Header.Clone(),
		Body:          body,
		Authorization: r.Header.Get("Authorization"),
	}
	s.mu.Lock()
	s.captured[route] = recorded
	s.mu.Unlock()
}

// envelope mirrors the backend response envelope. Internal to httpmock —
// production code uses the parallel struct in internal/client.
type envelope struct {
	Error     string      `json:"error,omitempty"`
	RequestID string      `json:"requestId,omitempty"`
	Status    int         `json:"status"`
	Result    interface{} `json:"result,omitempty"`
}

func writeEnvelope(t *testing.T, w http.ResponseWriter, httpStatus int, env envelope) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(httpStatus)
	if err := json.NewEncoder(w).Encode(env); err != nil {
		t.Fatalf("httpmock: encode envelope: %v", err)
	}
}

// readAll is io.ReadAll without import bloat — keeps this package on
// stdlib only.
func readAll(r *http.Request) ([]byte, error) {
	if r.Body == nil {
		return nil, nil
	}
	defer r.Body.Close()
	var b strings.Builder
	buf := make([]byte, 4096)
	for {
		n, err := r.Body.Read(buf)
		if n > 0 {
			b.Write(buf[:n])
		}
		if err != nil {
			break
		}
	}
	return []byte(b.String()), nil
}
