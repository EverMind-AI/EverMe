// Package runctx carries the process-level run context across the
// command-deadline boundary.
//
// cmdctx wraps each command's context with the global --timeout deadline
// before handing it to a command's RunE. A few long-blocking flows (the
// Device Flow human-approval wait) must detach that inherited deadline
// yet still honour a genuine cancellation (SIGINT). Once a deadline has
// elapsed a context's Err freezes to DeadlineExceeded, masking any later
// Canceled — so the only reliable way to observe a post-deadline cancel
// is to hold the un-deadlined cancellation source itself. cmdctx stashes
// that source here via WithBaseContext; detaching flows recover it with
// BaseContext.
package runctx

import "context"

// baseContextKey is the unexported key under which the un-deadlined
// cancellation source is stored. Unexported so only this package's
// accessors can read or write it.
type baseContextKey struct{}

// WithBaseContext returns a child of ctx that also carries base — the
// un-deadlined cancellation source (typically the signal.NotifyContext
// at the process root). cmdctx calls this right before layering the
// global --timeout deadline onto ctx.
func WithBaseContext(ctx, base context.Context) context.Context {
	return context.WithValue(ctx, baseContextKey{}, base)
}

// BaseContext returns the un-deadlined cancellation source previously
// stashed by WithBaseContext, or ctx itself when none was stashed. The
// fallback keeps callers correct in tests and code paths that never went
// through cmdctx's timeout wrapping.
func BaseContext(ctx context.Context) context.Context {
	if base, ok := ctx.Value(baseContextKey{}).(context.Context); ok && base != nil {
		return base
	}
	return ctx
}
