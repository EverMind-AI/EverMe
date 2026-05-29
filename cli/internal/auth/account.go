package auth

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// Account is the local cache of who's logged in. Persisted as
// $XDG_CONFIG_HOME/evercli/account.json. Non-secret — emk plaintext is
// never written here, only its prefix.
//
// Fields mirror the `auth status` / `auth me` data shape.
// AgentCount is populated by `auth me` (which calls /agents); offline
// `auth status` reads whatever was last cached and may render "—" if zero.
type Account struct {
	AccountID    string    `json:"accountId"`
	Email        string    `json:"email"`
	APIKeyPrefix string    `json:"apiKeyPrefix"`
	Scopes       []string  `json:"scopes,omitempty"`
	AgentCount   int       `json:"agentCount,omitempty"`
	RefreshedAt  time.Time `json:"refreshedAt,omitempty"`
}

// LoadAccount reads the cache file. Returns (nil, nil) when the file
// doesn't exist — callers treat that as "no cache, fall back to /auth/me".
// Other read errors (permission, malformed JSON) bubble up so they
// surface as a structured error rather than being silently ignored.
func LoadAccount(path string) (*Account, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var a Account
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, err
	}
	return &a, nil
}

// SaveAccount atomically writes the cache file with mode 0600. Atomic
// rename + fsync keeps the file from being read mid-write by another
// evercli process (e.g. concurrent `auth status`) and protects against
// a torn / zero-byte file when the process crashes between WriteFile
// and Rename. Any error path deletes the .tmp so a half-written
// snapshot doesn't linger on disk after a failure.
func SaveAccount(path string, a *Account) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	_ = os.Chmod(filepath.Dir(path), 0o700)
	raw, err := json.MarshalIndent(a, "", "  ")
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

// DeleteAccount removes the cache file. Idempotent — missing file is
// not an error.
func DeleteAccount(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}
