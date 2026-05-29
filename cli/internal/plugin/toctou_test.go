package plugin

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"evercli/internal/output"
)

// TestAssertNoConcurrentChange_ConcurrentEdit covers the C3 TOCTOU
// invariant: when Plan saw an
// existing config and Commit observes a different (mtime, size) we
// must refuse to overwrite. Without this defense the freshly-minted
// evt token would clobber whatever Claude Code / another evercli
// just wrote.
func TestAssertNoConcurrentChange_ConcurrentEdit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".claude.json")
	require.NoError(t, os.WriteFile(path, []byte(`{}`), 0o600))
	info, err := os.Stat(path)
	require.NoError(t, err)

	plan := &WritePlan{
		ConfigPath:      path,
		SnapshotModTime: info.ModTime().UnixNano(),
		SnapshotSize:    info.Size(),
	}

	// Simulate a concurrent writer changing the file between Plan and
	// Commit by rewriting with different content + bumping mtime.
	require.NoError(t, os.WriteFile(path, []byte(`{"someoneElse": true}`), 0o600))
	future := time.Now().Add(1 * time.Second)
	require.NoError(t, os.Chtimes(path, future, future))

	err = assertNoConcurrentChange(plan)
	require.Error(t, err)
	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Equal(t, output.TypeIO, ce.Type)
	assert.Contains(t, ce.Hint, "re-run")
}

func TestAssertNoConcurrentChange_ConcurrentCreate(t *testing.T) {
	// Plan saw NO file (WillCreate=true). Between Plan and Commit
	// another writer created one. We must refuse to overwrite — that
	// content is presumably the user's hand-written config and we'd
	// rather have them re-run install (which re-plans against the
	// new content) than clobber.
	dir := t.TempDir()
	path := filepath.Join(dir, ".claude.json")

	plan := &WritePlan{
		ConfigPath: path,
		WillCreate: true,
	}

	// File appears.
	require.NoError(t, os.WriteFile(path, []byte(`{}`), 0o600))

	err := assertNoConcurrentChange(plan)
	require.Error(t, err)
	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Equal(t, output.TypeIO, ce.Type)
	assert.Contains(t, ce.Hint, "re-run")
}

func TestAssertNoConcurrentChange_NoChange(t *testing.T) {
	// Happy path: Plan saw a file, Commit sees the same (mtime, size).
	dir := t.TempDir()
	path := filepath.Join(dir, ".claude.json")
	require.NoError(t, os.WriteFile(path, []byte(`{}`), 0o600))
	info, err := os.Stat(path)
	require.NoError(t, err)

	plan := &WritePlan{
		ConfigPath:      path,
		SnapshotModTime: info.ModTime().UnixNano(),
		SnapshotSize:    info.Size(),
	}
	assert.NoError(t, assertNoConcurrentChange(plan))
}

// TestWriteFileAtomic_FsyncedAndPersisted covers the recently-added
// fsync at the mcp.go atomic-write helper. We can't directly observe
// fsync from a test, but we can confirm round-trip correctness and
// that no .tmp residue survives a successful write.
func TestWriteFileAtomic_HappyPath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")

	require.NoError(t, writeFileAtomic(path, []byte(`{"x":1}`), 0o600))

	// File round-trips.
	raw, err := os.ReadFile(path)
	require.NoError(t, err)
	var got map[string]interface{}
	require.NoError(t, json.Unmarshal(raw, &got))
	assert.Equal(t, float64(1), got["x"])

	// Mode is what we asked for (Unix-only).
	if info, err := os.Stat(path); err == nil {
		// On Windows the mode mapping is different — checking only
		// that we're at least owner-writable.
		assert.NotZero(t, info.Mode().Perm())
	}

	// .tmp must be gone.
	_, statErr := os.Stat(path + ".tmp")
	assert.True(t, os.IsNotExist(statErr))
}

func TestWriteFileAtomic_FailureCleansTmp(t *testing.T) {
	// Force a rename failure by making path point at an existing
	// directory. mkdir is the simplest setup; the rename then fails
	// with "is a directory".
	dir := t.TempDir()
	path := filepath.Join(dir, "as-dir")
	require.NoError(t, os.MkdirAll(path, 0o700))

	err := writeFileAtomic(path, []byte("body"), 0o600)
	require.Error(t, err, "rename onto a directory must fail")

	// .tmp must NOT linger after the failed write — that's the
	// cleanup contract; failure must not leave a fresh-token-bearing
	// file on disk.
	_, statErr := os.Stat(path + ".tmp")
	assert.True(t, os.IsNotExist(statErr), "orphan .tmp left behind after rename failure")
}

// helper to avoid an unused-import warning if the package layout
// changes such that context is no longer touched in this file.
var _ context.Context = context.Background()
