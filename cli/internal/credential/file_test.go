package credential

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newFileFixture(t *testing.T) *FileProvider {
	t.Helper()
	dir := t.TempDir()
	// t.TempDir() returns 0755 on macOS; tighten to 0700 so the new
	// parent-directory permission check (assertSecureDir) doesn't fire
	// in tests that pre-populate the file directly via os.WriteFile.
	require.NoError(t, os.Chmod(dir, 0o700))
	return NewFile(filepath.Join(dir, "credentials.json"))
}

func TestFile_RoundTrip(t *testing.T) {
	ctx := context.Background()
	f := newFileFixture(t)

	_, err := f.Get(ctx, APIKey())
	assert.True(t, errors.Is(err, ErrNotFound), "fresh provider returns NotFound")

	require.NoError(t, f.Set(ctx, APIKey(), "emk_abc"))
	got, err := f.Get(ctx, APIKey())
	require.NoError(t, err)
	assert.Equal(t, "emk_abc", got)

	require.NoError(t, f.Delete(ctx, APIKey()))
	_, err = f.Get(ctx, APIKey())
	assert.True(t, errors.Is(err, ErrNotFound))
}

func TestFile_Set_WritesMode0600_OnUnix(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows file modes don't map to NTFS ACLs")
	}
	ctx := context.Background()
	f := newFileFixture(t)
	require.NoError(t, f.Set(ctx, APIKey(), "emk_abc"))

	info, err := os.Stat(f.Path())
	require.NoError(t, err)
	assert.EqualValues(t, 0o600, info.Mode().Perm(), "credentials file must land at 0600")
}

func TestFile_RefusesOverWidePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("permission gate is Unix-only")
	}
	ctx := context.Background()
	f := newFileFixture(t)
	require.NoError(t, f.Set(ctx, APIKey(), "emk_abc"))
	// Loosen perms to 0644 — Get must refuse.
	require.NoError(t, os.Chmod(f.Path(), 0o644))

	_, err := f.Get(ctx, APIKey())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "over-wide", "error must guide user to chmod 600")
}

func TestFile_Delete_LastEntry_RemovesFile(t *testing.T) {
	ctx := context.Background()
	f := newFileFixture(t)
	require.NoError(t, f.Set(ctx, APIKey(), "emk_abc"))
	require.NoError(t, f.Delete(ctx, APIKey()))

	_, err := os.Stat(f.Path())
	assert.True(t, os.IsNotExist(err), "removing the last credential must drop the file")
}

func TestFile_Delete_KeepsOtherEntries(t *testing.T) {
	ctx := context.Background()
	f := newFileFixture(t)
	other := Key{Namespace: "evercli", Name: "future-other"}
	require.NoError(t, f.Set(ctx, APIKey(), "emk_abc"))
	require.NoError(t, f.Set(ctx, other, "other-secret"))

	require.NoError(t, f.Delete(ctx, APIKey()))

	v, err := f.Get(ctx, other)
	require.NoError(t, err)
	assert.Equal(t, "other-secret", v, "deleting one key must leave siblings alone")

	_, err = f.Get(ctx, APIKey())
	assert.True(t, errors.Is(err, ErrNotFound))
}

func TestFile_Delete_Idempotent(t *testing.T) {
	ctx := context.Background()
	f := newFileFixture(t)
	assert.NoError(t, f.Delete(ctx, APIKey()), "deleting from a non-existent file is a no-op")
}

func TestFile_AtomicWrite_NoTmpLeftBehind(t *testing.T) {
	ctx := context.Background()
	f := newFileFixture(t)
	require.NoError(t, f.Set(ctx, APIKey(), "emk_abc"))

	// .tmp must not linger after a successful write.
	_, err := os.Stat(f.Path() + ".tmp")
	assert.True(t, os.IsNotExist(err), "atomic write must clean up .tmp on success")
}

func TestFile_CorruptedJSON_ReturnsError(t *testing.T) {
	ctx := context.Background()
	f := newFileFixture(t)
	require.NoError(t, os.MkdirAll(filepath.Dir(f.Path()), 0o700))
	require.NoError(t, os.WriteFile(f.Path(), []byte("not json"), 0o600))

	_, err := f.Get(ctx, APIKey())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "corrupted")
}

func TestFile_EmptyFile_ReturnsNotFound(t *testing.T) {
	ctx := context.Background()
	f := newFileFixture(t)
	require.NoError(t, os.MkdirAll(filepath.Dir(f.Path()), 0o700))
	require.NoError(t, os.WriteFile(f.Path(), []byte{}, 0o600))

	_, err := f.Get(ctx, APIKey())
	assert.True(t, errors.Is(err, ErrNotFound), "empty file decodes to NotFound, not corruption")
}
