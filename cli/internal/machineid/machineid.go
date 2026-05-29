// Package machineid produces a stable per-machine, per-user, per-platform
// identifier for EverMe's agent uniqueness constraint.
//
// Stability invariant: the same {machine, user, platform} must yield the
// same hash across processes and reboots; otherwise EverMe will accumulate
// duplicate agent rows.
package machineid

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/user"
	"sync"

	osmid "github.com/denisbrodbeck/machineid"
)

var (
	idOnce sync.Once
	cached string
)

// ID returns the OS-native machine identifier (IOPlatformUUID on macOS,
// /etc/machine-id on Linux, registry MachineGuid on Windows). On read
// failure it falls back to hostname so callers never see an empty string.
//
// The value is cached on first call.
func ID() string {
	idOnce.Do(func() {
		if v, err := osmid.ID(); err == nil && v != "" {
			cached = v
			return
		}
		if h, err := os.Hostname(); err == nil && h != "" {
			cached = h
			return
		}
		cached = "unknown-machine"
	})
	return cached
}

// Fingerprint returns sha256(ID \0 username \0 platform) as hex.
//
// platform should be a registered EverMe client identifier ("evercli",
// "claude-code", "openclaw", ...) — NOT an OS string. Pass the same
// platform value as is sent in the corresponding API field so server-side
// agent rows align.
func Fingerprint(platform string) string {
	uname := username()
	h := sha256.New()
	h.Write([]byte(ID()))
	h.Write([]byte{0})
	h.Write([]byte(uname))
	h.Write([]byte{0})
	h.Write([]byte(platform))
	return hex.EncodeToString(h.Sum(nil))
}

func username() string {
	if u, err := user.Current(); err == nil && u.Username != "" {
		return u.Username
	}
	if v := os.Getenv("USER"); v != "" {
		return v
	}
	if v := os.Getenv("USERNAME"); v != "" {
		return v
	}
	return "unknown-user"
}
