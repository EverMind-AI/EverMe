package credential

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMemProvider_RoundTrip(t *testing.T) {
	ctx := context.Background()
	m := NewMem()

	_, err := m.Get(ctx, APIKey())
	assert.True(t, errors.Is(err, ErrNotFound))

	require.NoError(t, m.Set(ctx, APIKey(), "emk_abc"))
	got, err := m.Get(ctx, APIKey())
	require.NoError(t, err)
	assert.Equal(t, "emk_abc", got)

	require.NoError(t, m.Delete(ctx, APIKey()))
	_, err = m.Get(ctx, APIKey())
	assert.True(t, errors.Is(err, ErrNotFound), "Delete must remove the entry")
}

func TestMemProvider_DeleteIsIdempotent(t *testing.T) {
	ctx := context.Background()
	m := NewMem()
	assert.NoError(t, m.Delete(ctx, APIKey()), "deleting a missing key is a no-op")
}

func TestEnvProvider_ReadOnly(t *testing.T) {
	ctx := context.Background()
	e := NewEnv()
	assert.True(t, errors.Is(e.Set(ctx, APIKey(), "x"), ErrReadOnly))
	assert.True(t, errors.Is(e.Delete(ctx, APIKey()), ErrReadOnly))
}

func TestEnvProvider_GetReadsEnv(t *testing.T) {
	ctx := context.Background()
	// EnvProvider does a permissive shape check now; supply a value that
	// matches the emk_<>=20 alphanumeric pattern so this test exercises
	// the happy path. The strict 32-hex form is enforced by validate.APIKey.
	t.Setenv(envVar, "emk_abcdef0123456789abcd")
	e := NewEnv()
	got, err := e.Get(ctx, APIKey())
	require.NoError(t, err)
	assert.Equal(t, "emk_abcdef0123456789abcd", got)
}

func TestEnvProvider_GetRejectsObviousJunk(t *testing.T) {
	ctx := context.Background()
	t.Setenv(envVar, "paste here please")
	e := NewEnv()
	_, err := e.Get(ctx, APIKey())
	require.Error(t, err, "EnvProvider must surface a typed error for malformed env values")
}

func TestEnvProvider_TrimsWhitespace(t *testing.T) {
	ctx := context.Background()
	t.Setenv(envVar, "  emk_abcdef0123456789abcd  \n")
	e := NewEnv()
	got, err := e.Get(ctx, APIKey())
	require.NoError(t, err)
	assert.Equal(t, "emk_abcdef0123456789abcd", got)
}

func TestEnvProvider_GetUnknownKey(t *testing.T) {
	ctx := context.Background()
	e := NewEnv()
	_, err := e.Get(ctx, Key{Namespace: "evercli", Name: "other"})
	assert.True(t, errors.Is(err, ErrNotFound))
}
