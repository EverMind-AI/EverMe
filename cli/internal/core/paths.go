package core

import (
	"os"
	"path/filepath"
	"runtime"
)

// Paths holds the directories evercli reads / writes from. All paths are
// resolved through XDG when set, falling back to the platform-canonical
// location otherwise.
//
// Three buckets:
//   - ConfigDir: $XDG_CONFIG_HOME/evercli (config.yaml, account.json)
//   - DataDir:   $XDG_DATA_HOME/evercli   (credentials.enc, device-session.json, logs)
//   - CacheDir:  $XDG_CACHE_HOME/evercli  (downloaded skills, lockfiles, tmp merge buffers)
//
// On Windows we map config→%APPDATA%, data→%LOCALAPPDATA%, cache→%LOCALAPPDATA%\Cache.
type Paths struct {
	ConfigDir string
	DataDir   string
	CacheDir  string
}

// DefaultPaths resolves the standard XDG-flavored locations.
func DefaultPaths() (*Paths, error) {
	cfg, err := xdgPath("XDG_CONFIG_HOME", configFallback(), "evercli")
	if err != nil {
		return nil, err
	}
	data, err := xdgPath("XDG_DATA_HOME", dataFallback(), "evercli")
	if err != nil {
		return nil, err
	}
	cache, err := xdgPath("XDG_CACHE_HOME", cacheFallback(), "evercli")
	if err != nil {
		return nil, err
	}
	return &Paths{ConfigDir: cfg, DataDir: data, CacheDir: cache}, nil
}

// ConfigFile returns the canonical config.yaml path.
func (p *Paths) ConfigFile() string { return filepath.Join(p.ConfigDir, "config.yaml") }

// AccountFile returns the canonical account.json path (cached login state).
func (p *Paths) AccountFile() string { return filepath.Join(p.ConfigDir, "account.json") }

// DeviceSessionFile returns the path used for `auth login --no-wait`
// session persistence (deviceCode + verificationUrl + expiresAt).
func (p *Paths) DeviceSessionFile() string { return filepath.Join(p.DataDir, "device-session.json") }

// CredentialsFile returns the path used by FileProvider for the
// plaintext JSON credential file. Created lazily; permission `0600` on
// Unix. Cross-platform default — matches gh / aws / gcloud convention.
func (p *Paths) CredentialsFile() string { return filepath.Join(p.DataDir, "credentials.json") }

// LogFile returns the rolling log location. Used by internal/logger when
// file-mode logging is enabled (default off).
func (p *Paths) LogFile() string { return filepath.Join(p.DataDir, "evercli.log") }

// xdgPath honors $XDG_<bucket>_HOME when it points at an absolute path,
// falling back to the platform default otherwise. The XDG spec says
// implementations MUST ignore relative XDG values; doing so closes the
// "XDG_CONFIG_HOME=:evil" / "XDG_CONFIG_HOME=../etc" footgun that
// would otherwise produce credentials.json under the cwd.
func xdgPath(envVar, fallbackDir, app string) (string, error) {
	if v := os.Getenv(envVar); v != "" && filepath.IsAbs(v) {
		return filepath.Join(v, app), nil
	}
	return filepath.Join(fallbackDir, app), nil
}

func configFallback() string {
	if runtime.GOOS == "windows" {
		if v := os.Getenv("APPDATA"); v != "" {
			return v
		}
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config")
}

func dataFallback() string {
	if runtime.GOOS == "windows" {
		if v := os.Getenv("LOCALAPPDATA"); v != "" {
			return v
		}
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "share")
}

func cacheFallback() string {
	if runtime.GOOS == "windows" {
		if v := os.Getenv("LOCALAPPDATA"); v != "" {
			return filepath.Join(v, "Cache")
		}
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".cache")
}
