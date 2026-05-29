package core

import (
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/asaskevich/govalidator"
	"github.com/spf13/viper"
)

// Config is the evercli runtime configuration. It is sourced from
// (in priority order, highest first):
//
//  1. command-line flags
//  2. environment variables prefixed EVERCLI_*
//  3. config.yaml in --config path or default XDG location
//  4. compiled-in defaults
//
// We expose only what tests and commands need; viper-internal state stays
// inside this package.
//
// Validation: APIBaseURL is required and must parse as an absolute
// http(s) URL — we surface a structured error before any client.New
// call so a malformed config can't cause silent SSRF / wrong-host
// behavior at request time. govalidator is the project-wide validator.
type Config struct {
	APIBaseURL string        `valid:"required,url"`
	Timeout    time.Duration `valid:"-"`
	Paths      *Paths        `valid:"-"`
}

// LoadConfig resolves Paths, then loads config.yaml (if present) merged
// with EVERCLI_* env vars and the supplied overrides. configPath may be
// empty, in which case Paths.ConfigFile() is used.
func LoadConfig(configPath string) (*Config, error) {
	paths, err := DefaultPaths()
	if err != nil {
		return nil, fmt.Errorf("resolve paths: %w", err)
	}

	v := viper.New()
	v.SetEnvPrefix("EVERCLI")
	// Map EVERCLI_API_BASE_URL → api_base_url. Without this replacer
	// viper looks for the env var literally as "api_base_url" (with
	// dots/underscores untouched), so the env-var override the docs
	// promise was previously silently ignored.
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_", "-", "_"))
	v.AutomaticEnv()

	v.SetDefault("api_base_url", "https://api.everme.evermind.ai")
	v.SetDefault("timeout", "60s")

	if configPath == "" {
		configPath = paths.ConfigFile()
	}
	v.SetConfigFile(configPath)
	if err := v.ReadInConfig(); err != nil {
		// Config file is optional. Ignore missing-file errors but surface
		// genuine parse / permission failures. Use errors.Is(err, fs.ErrNotExist)
		// instead of os.IsNotExist because viper sometimes wraps the
		// PathError inside its own type that os.IsNotExist can't peel.
		var nf viper.ConfigFileNotFoundError
		if !errors.As(err, &nf) && !errors.Is(err, fs.ErrNotExist) {
			return nil, fmt.Errorf("read config %s: %w", configPath, err)
		}
	}

	timeout, err := time.ParseDuration(v.GetString("timeout"))
	if err != nil {
		return nil, fmt.Errorf("invalid timeout %q: %w", v.GetString("timeout"), err)
	}

	cfg := &Config{
		APIBaseURL: strings.TrimSpace(v.GetString("api_base_url")),
		Timeout:    timeout,
		Paths:      paths,
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

// Validate enforces the project-standard govalidator rules on the
// loaded config plus a couple of CLI-specific extras (scheme must be
// http or https; otherwise client.New would happily produce a request
// to `javascript:alert(1)/auth/login`).
func (c *Config) Validate() error {
	if _, err := govalidator.ValidateStruct(c); err != nil {
		return fmt.Errorf("invalid config: %w", err)
	}
	u, err := url.Parse(c.APIBaseURL)
	if err != nil {
		return fmt.Errorf("invalid api_base_url %q: %w", c.APIBaseURL, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("invalid api_base_url scheme %q (want http or https)", u.Scheme)
	}
	if u.Host == "" {
		return fmt.Errorf("invalid api_base_url %q: missing host", c.APIBaseURL)
	}
	return nil
}

// EnsureDirs creates ConfigDir / DataDir / CacheDir with appropriate
// permissions. Idempotent. Call this once during bootstrap before any
// component tries to write under Paths.
func (c *Config) EnsureDirs() error {
	for _, d := range []string{c.Paths.ConfigDir, c.Paths.DataDir, c.Paths.CacheDir} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return fmt.Errorf("mkdir %s: %w", d, err)
		}
	}
	return nil
}

// ConfigPath returns the file viper would read for this Config. Useful
// for `evercli config show --format text` and doctor diagnostics.
func (c *Config) ConfigPath() string { return filepath.Join(c.Paths.ConfigDir, "config.yaml") }
