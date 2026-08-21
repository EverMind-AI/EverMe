package runctx_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"

	"evercli/internal/runctx"
)

func TestBaseContext_ReturnsStashedSource(t *testing.T) {
	type marker struct{}
	base := context.WithValue(context.Background(), marker{}, "signal")
	wrapped, cancel := context.WithTimeout(base, 0) // deadline already elapsed
	defer cancel()
	wrapped = runctx.WithBaseContext(wrapped, base)

	got := runctx.BaseContext(wrapped)
	assert.Same(t, base, got, "must recover the exact un-deadlined source")
	assert.Nil(t, got.Err(), "the source carries no elapsed deadline")
}

func TestBaseContext_FallsBackToCtxWhenNoneStashed(t *testing.T) {
	ctx := context.Background()
	assert.True(t, ctx == runctx.BaseContext(ctx),
		"with no stashed source BaseContext returns the context unchanged")
}
