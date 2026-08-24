package imports

import (
	"context"
	"testing"
	"time"

	"evercli/internal/runctx"
)

// The run loop is a bulk, long-running upload. BuildDeps wraps cmd.Context()
// with the global --timeout as a SINGLE budget for the whole command; applied
// to a sequential per-session loop that wrongly fails every session past the
// deadline (queued ... then a contiguous block of "context deadline exceeded").
// perSessionContext must re-derive a FRESH deadline per session from the
// un-deadlined signal source, so --timeout bounds each session, not the loop.

func TestPerSessionContext_DerivesFreshDeadlineFromBase(t *testing.T) {
	type marker struct{}
	base := context.WithValue(context.Background(), marker{}, "signal")

	// Simulate the command ctx whose global --timeout has already elapsed.
	elapsed, cancel := context.WithTimeout(base, 0)
	defer cancel()
	elapsed = runctx.WithBaseContext(elapsed, base)
	if elapsed.Err() == nil {
		t.Fatalf("precondition: command ctx must already be past its deadline")
	}

	sess, scancel := perSessionContext(elapsed, 30*time.Second)
	defer scancel()

	if sess.Err() != nil {
		t.Fatalf("per-session ctx must be live, got Err=%v", sess.Err())
	}
	dl, ok := sess.Deadline()
	if !ok {
		t.Fatalf("per-session ctx must carry a deadline")
	}
	if !dl.After(time.Now()) {
		t.Fatalf("per-session deadline must be in the future, got %v", dl)
	}
	if sess.Value(marker{}) != "signal" {
		t.Fatalf("per-session ctx must derive from the un-deadlined signal source")
	}
}

func TestPerSessionContext_TimeoutZeroNoDeadline(t *testing.T) {
	base := context.Background()
	elapsed, cancel := context.WithTimeout(base, 0)
	defer cancel()
	elapsed = runctx.WithBaseContext(elapsed, base)

	sess, scancel := perSessionContext(elapsed, 0)
	defer scancel()

	if _, ok := sess.Deadline(); ok {
		t.Fatalf("--timeout 0 must yield an un-deadlined per-session ctx")
	}
	if sess.Err() != nil {
		t.Fatalf("per-session ctx must be live, got Err=%v", sess.Err())
	}
}
