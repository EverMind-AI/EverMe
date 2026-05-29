//go:build !windows

package credential

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// fileLock is a thin wrapper around flock(2) used to serialize the
// read-modify-write cycle of the credential file across multiple evercli
// processes. The intra-process sync.Mutex on FileProvider only protects
// against same-process races; the lock here closes the gap two CLI
// invocations would otherwise create (e.g. an agent runner spawning
// `auth status` while the user runs `auth login`).
//
// The lock file lives next to credentials.json with a `.lock` suffix.
// We never write to it; it exists purely as a flock target. fsnotify-
// style cleanup is intentionally absent — orphaned `.lock` files are
// zero-byte and cheap.
type fileLock struct {
	f *os.File
}

func acquireFileLock(target string) (*fileLock, error) {
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return nil, err
	}
	lockPath := target + ".lock"
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := unix.Flock(int(f.Fd()), unix.LOCK_EX); err != nil {
		_ = f.Close()
		return nil, err
	}
	return &fileLock{f: f}, nil
}

func (l *fileLock) Release() {
	if l == nil || l.f == nil {
		return
	}
	_ = unix.Flock(int(l.f.Fd()), unix.LOCK_UN)
	_ = l.f.Close()
}
