package auth

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDeviceSession_Expired_HonorsClockSkewGrace(t *testing.T) {
	// Server-issued expiry; our local clock can be a few seconds ahead
	// and we'd rather refresh slightly early than poll a deviceCode
	// the server is about to reject. Grace is 5s (one poll interval).
	expires := time.Date(2026, 5, 9, 12, 0, 0, 0, time.UTC)
	s := &DeviceSession{ExpiresAt: expires}

	// 1s before nominal expiry — well inside the 5s grace window.
	assert.True(t, s.Expired(expires.Add(-1*time.Second)),
		"within grace window must report expired so the caller doesn't waste a poll")

	// 30s before nominal expiry — outside the 5s grace window.
	assert.False(t, s.Expired(expires.Add(-30*time.Second)))

	// After expiry: definitely expired.
	assert.True(t, s.Expired(expires.Add(time.Second)))

	// Zero-value session must NOT pretend to be valid.
	zero := &DeviceSession{}
	assert.True(t, zero.Expired(time.Now()),
		"zero-value DeviceSession must read as expired (no ExpiresAt = no validity)")
}

func TestSaveLoadDeviceSession_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "device-session.json")

	want := &DeviceSession{
		DeviceCode:      "dc_123",
		UserCode:        "ABCD-EFGH",
		VerificationURL: "https://everme.evermind.ai/verify",
		ExpiresAt:       time.Now().Add(5 * time.Minute).UTC().Truncate(time.Second),
		CreatedAt:       time.Now().UTC().Truncate(time.Second),
		Interval:        5,
	}
	require.NoError(t, SaveDeviceSession(path, want))

	got, err := LoadDeviceSession(path)
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, want.DeviceCode, got.DeviceCode)
	assert.Equal(t, want.UserCode, got.UserCode)
	assert.Equal(t, want.VerificationURL, got.VerificationURL)
	assert.Equal(t, want.Interval, got.Interval)

	// .tmp must not linger after a successful write — fsync rollback
	// regression.
	_, err = os.Stat(path + ".tmp")
	assert.True(t, os.IsNotExist(err), "atomic write must clean up .tmp on success")
}

func TestSaveDeviceSession_FailureCleansTmp(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("rename-onto-directory failure semantics differ on Windows")
	}
	// Force a real failure at the rename step: pre-create a directory
	// at the destination path so writeFileFsync's `os.Rename(tmp, path)`
	// returns "is a directory". The earlier MkdirAll/Chmod inside
	// SaveDeviceSession can't undo this — the destination IS the
	// directory, not the parent. We then assert:
	//
	//   1. SaveDeviceSession returns a non-nil error (no silent success).
	//   2. The tmp file is cleaned up (cleanup contract — a failed
	//      write must not leave an orphan containing the marshalled
	//      session payload).
	parent := t.TempDir()
	path := filepath.Join(parent, "device-session.json")
	require.NoError(t, os.MkdirAll(path, 0o700)) // <- destination is a DIR

	err := SaveDeviceSession(path, &DeviceSession{DeviceCode: "should-not-land-on-disk"})
	require.Error(t, err, "rename onto an existing directory must fail")

	entries, statErr := os.ReadDir(parent)
	require.NoError(t, statErr)
	for _, e := range entries {
		assert.False(t, strings.HasSuffix(e.Name(), ".tmp"),
			"orphan .tmp left behind: %s — failure path must clean up", e.Name())
	}
}

func TestSaveDeviceSession_HappyPath(t *testing.T) {
	// Sibling round-trip kept after the rewrite of FailureCleansTmp so
	// the JSON shape regression check still has a home.
	path := filepath.Join(t.TempDir(), "device-session.json")
	require.NoError(t, SaveDeviceSession(path, &DeviceSession{DeviceCode: "x"}))

	raw, err := os.ReadFile(path)
	require.NoError(t, err)
	var s DeviceSession
	require.NoError(t, json.Unmarshal(raw, &s))
	assert.Equal(t, "x", s.DeviceCode)
}

func TestDeleteDeviceSession_Idempotent(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "absent.json")
	assert.NoError(t, DeleteDeviceSession(missing), "deleting a missing file is a no-op")
}
