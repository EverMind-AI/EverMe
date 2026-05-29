package credential

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sync"

	"evercli/internal/core"
)

// FileProvider stores credentials as a plain JSON file at mode 0600 —
// the only persistent backend. Matches the convention of every major
// OSS CLI (gh, aws, gcloud, kubectl, doctl, flyctl, supabase, stripe,
// wrangler).
//
// Threat model: a same-user attacker can already replace the binary,
// scrape memory, or read $HOME directly, so encrypting at rest provides
// little marginal protection while costing material UX (keychain
// prompts, headless / SSH / container friction).
//
// On Unix the file mode is enforced as 0600 (read tightens to refuse
// over-wide modes), the parent directory is enforced as 0700, and the
// read-modify-write cycle is serialized across processes via flock(2).
// On Windows file modes don't map to NTFS ACLs; protection comes from
// the per-user %LOCALAPPDATA% profile path, matching gh CLI's behavior.
type FileProvider struct {
	path string
	mu   sync.Mutex
}

// NewFile returns a FileProvider rooted at the given path. Callers
// usually go through NewFileFromPaths.
func NewFile(path string) *FileProvider { return &FileProvider{path: path} }

// NewFileFromPaths resolves the canonical credentials file under
// $XDG_DATA_HOME/evercli/credentials.json (or platform fallback).
func NewFileFromPaths(paths *core.Paths) *FileProvider {
	return NewFile(paths.CredentialsFile())
}

func (f *FileProvider) Name() string { return "file" }

// Path returns the on-disk credentials file path. Surfaced for doctor
// diagnostics and `debug bundle` redaction.
func (f *FileProvider) Path() string { return f.path }

func (f *FileProvider) Get(_ context.Context, key Key) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	lk, err := acquireFileLock(f.path)
	if err != nil {
		return "", err
	}
	defer lk.Release()

	raw, err := os.ReadFile(f.path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", ErrNotFound
		}
		return "", err
	}
	// File mode is the actual secret-bearing file — keep this strict:
	// 0644 emk on disk is a real regression and the user should know.
	if err := assertSecurePerms(f.path); err != nil {
		return "", err
	}
	// Parent-dir mode is a softer signal. In real-world setups
	// $XDG_DATA_HOME / $XDG_CONFIG_HOME often inherits 0755 from the
	// shell's umask 022 — the user has been writing emk through us for
	// weeks, then a CLI upgrade adds this check and `auth status`
	// suddenly errors. Auto-tighten to 0700 on the read path so
	// upgrade-time failures don't crater workflows; assertSecureDir
	// stays as the post-condition (if the chmod didn't take, do
	// surface the error). The set / write paths already chmod 0700
	// inside writeLocked — this just brings read into parity.
	dir := filepath.Dir(f.path)
	if err := assertSecureDir(dir); err != nil {
		_ = os.Chmod(dir, 0o700)
		if err2 := assertSecureDir(dir); err2 != nil {
			return "", err2
		}
	}
	if len(raw) == 0 {
		return "", ErrNotFound
	}
	var m map[string]string
	if err := json.Unmarshal(raw, &m); err != nil {
		return "", fmt.Errorf("credentials file %s is corrupted: %w", f.path, err)
	}
	v, ok := m[key.Name]
	if !ok || v == "" {
		return "", ErrNotFound
	}
	return v, nil
}

func (f *FileProvider) Set(_ context.Context, key Key, value string) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	lk, err := acquireFileLock(f.path)
	if err != nil {
		return err
	}
	defer lk.Release()

	m, err := f.readLocked()
	if err != nil {
		return err
	}
	if m == nil {
		m = map[string]string{}
	}
	m[key.Name] = value
	return f.writeLocked(m)
}

func (f *FileProvider) Delete(_ context.Context, key Key) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	lk, err := acquireFileLock(f.path)
	if err != nil {
		return err
	}
	defer lk.Release()

	m, err := f.readLocked()
	if err != nil {
		return err
	}
	if m == nil {
		return nil // idempotent: nothing to delete
	}
	if _, present := m[key.Name]; !present {
		return nil
	}
	delete(m, key.Name)
	if len(m) == 0 {
		// No entries left — drop the file entirely so users see a clean
		// state. `auth status` then returns NotFound rather than a
		// pointlessly-empty file.
		if err := os.Remove(f.path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		return nil
	}
	return f.writeLocked(m)
}

// readLocked reads the file under the assumption mu (and the file
// lock) are already held. Missing file → (nil, nil); corruption
// surfaces an error so users know to investigate rather than silently
// get NotFound.
func (f *FileProvider) readLocked() (map[string]string, error) {
	raw, err := os.ReadFile(f.path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	if len(raw) == 0 {
		return map[string]string{}, nil
	}
	var m map[string]string
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("credentials file %s is corrupted: %w", f.path, err)
	}
	return m, nil
}

// writeLocked atomically rewrites the file with mode 0600 and an fsync
// on the data + parent dir so a crash between WriteFile and Rename
// can't surface a torn or zero-byte file. Atomic via O_CREATE|O_EXCL +
// rename so a concurrent reader never sees a half-written file or
// inherits the mode of a stale .tmp from a previous crash.
func (f *FileProvider) writeLocked(m map[string]string) error {
	parent := filepath.Dir(f.path)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return err
	}
	// Tighten the parent if it pre-existed at a wider mode (MkdirAll is
	// a no-op when the directory already exists, so the 0700 above
	// doesn't actually shrink an inherited 0755).
	_ = os.Chmod(parent, 0o700)

	raw, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	if err := writeFileFsync(f.path, raw, 0o600); err != nil {
		return err
	}
	// Final defense: if the file pre-existed at a wider mode and our
	// rename inherited it, tighten now.
	_ = os.Chmod(f.path, 0o600)
	return nil
}

// writeFileFsync writes body to path atomically:
//  1. open <path>.tmp with O_CREATE|O_EXCL — fails if a stale .tmp is
//     present so we can't accidentally overwrite a running peer's
//     half-written file.
//  2. write + fsync the tmp.
//  3. rename tmp → path.
//  4. fsync the parent directory so the rename hits stable storage
//     before we return success.
//
// Any error along the way deletes the orphaned .tmp — it would
// otherwise linger on disk containing the freshly-marshalled emk.
func writeFileFsync(path string, body []byte, mode os.FileMode) error {
	tmp := path + ".tmp"
	// Best-effort cleanup of stale tmp from a previous crash. We then
	// open with O_EXCL so a racing peer can't sneak in.
	_ = os.Remove(tmp)
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	cleanup := func() { _ = os.Remove(tmp) }

	if _, err := f.Write(body); err != nil {
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
	// fsync the parent directory so the rename is durable. Best-effort:
	// some filesystems (overlayfs, certain CIFS mounts) don't support
	// directory fsync; we don't surface that as a hard failure.
	if dir, dirErr := os.Open(filepath.Dir(path)); dirErr == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}

// assertSecurePerms checks that the file mode is 0600 (or stricter) on
// Unix. Windows is exempt — file modes don't map to NTFS ACLs there;
// the per-user %LOCALAPPDATA% directory is the security boundary.
func assertSecurePerms(path string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	mode := info.Mode().Perm()
	// Group/other bits must all be zero. 0600 is canonical; 0400 also OK.
	if mode&0o077 != 0 {
		return fmt.Errorf(
			"credentials file %s has over-wide mode %#o; run `chmod 600 %s` to fix",
			path, mode, path,
		)
	}
	return nil
}

// assertSecureDir mirrors assertSecurePerms for the parent directory.
// A 0755 ConfigDir is a real-world hazard when XDG_CONFIG_HOME was
// created by another tool before evercli; without this check the
// credentials file's 0600 mode protects nothing because a same-user
// peer can readdir the parent.
func assertSecureDir(path string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	mode := info.Mode().Perm()
	if mode&0o077 != 0 {
		return fmt.Errorf(
			"credentials directory %s has over-wide mode %#o; run `chmod 700 %s` to fix",
			path, mode, path,
		)
	}
	return nil
}
