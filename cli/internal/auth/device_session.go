package auth

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// DeviceSession is what `auth login --no-wait` writes so a later
// `auth login --device-code` (typically issued by an AI Agent on the
// user's behalf) can resume polling without the deviceCode value
// floating around in shell history.
//
// Persisted as $XDG_DATA_HOME/evercli/device-session.json with mode 0600
// (the file contains the deviceCode which is single-use and short-lived,
// but is still sensitive enough to warrant 0600).
type DeviceSession struct {
	DeviceCode      string    `json:"deviceCode"`
	UserCode        string    `json:"userCode"`
	VerificationURL string    `json:"verificationUrl"`
	ExpiresAt       time.Time `json:"expiresAt"`
	CreatedAt       time.Time `json:"createdAt"`
	Interval        int       `json:"interval"` // server-suggested poll interval, seconds
}

// clockSkewGrace tolerates a small clock-drift window before declaring
// a session expired. Without this, a laptop running a few seconds
// ahead of the EverMe server fails poll resumes that the server still
// considers valid; with it, callers stop looking at locally-cached
// state slightly before the server hands out a hard "expired" — the
// right direction (ask the server than act on stale local timing).
//
// 5s ≈ one Device Flow poll interval. A larger value would carve a
// meaningful fraction off the 5-minute session TTL for users with no
// clock drift. The backend enforces the final expiry deadline.
const clockSkewGrace = 5 * time.Second

// Expired reports whether the session is past its server-issued deadline,
// with a small clock-skew tolerance. Callers treat expired sessions like
// missing ones: the user needs to run `auth login --no-wait` again to
// get a fresh deviceCode.
func (s *DeviceSession) Expired(now time.Time) bool {
	return now.After(s.ExpiresAt.Add(-clockSkewGrace))
}

// LoadDeviceSession reads the file at path. Missing file → (nil, nil) so
// callers can branch cleanly without errors.Is checks at every site.
func LoadDeviceSession(path string) (*DeviceSession, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var s DeviceSession
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// SaveDeviceSession atomically writes the session with mode 0600. We
// fsync the data + parent dir so a crash between WriteFile and Rename
// can't leave a torn or zero-byte file; any error path cleans up the
// .tmp.
func SaveDeviceSession(path string, s *DeviceSession) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	_ = os.Chmod(filepath.Dir(path), 0o700)
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	_ = os.Remove(tmp)
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	cleanup := func() { _ = os.Remove(tmp) }
	if _, err := f.Write(raw); err != nil {
		_ = f.Close()
		cleanup()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		cleanup()
		return err
	}
	if err := f.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		cleanup()
		return err
	}
	if dir, dirErr := os.Open(filepath.Dir(path)); dirErr == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}

// DeleteDeviceSession removes the session file (idempotent).
func DeleteDeviceSession(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}
