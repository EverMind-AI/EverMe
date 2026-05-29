package core

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// withXDG redirects every XDG bucket into a per-test tmp dir. Returns the
// resolved Paths so individual tests can assert against them.
func withXDG(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "cfg"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(root, "data"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(root, "cache"))
	return root
}

func TestLoadConfig_DefaultsWhenFileMissing(t *testing.T) {
	withXDG(t)
	cfg, err := LoadConfig("")
	require.NoError(t, err, "missing config.yaml is not an error — falls back to compiled defaults")
	require.NotNil(t, cfg)
	assert.Equal(t, "https://api.everme.evermind.ai", cfg.APIBaseURL, "default base URL must match the production gateway")
	assert.Equal(t, 60*time.Second, cfg.Timeout, "default timeout must match cmd-side --timeout default")
	assert.NotNil(t, cfg.Paths)
}

func TestLoadConfig_FileOverridesDefaults(t *testing.T) {
	root := withXDG(t)
	cfgPath := filepath.Join(root, "evercli.yaml")
	require.NoError(t, os.WriteFile(cfgPath, []byte(`
api_base_url: "https://staging.everme.evermind.ai"
timeout: "5s"
`), 0o600))

	cfg, err := LoadConfig(cfgPath)
	require.NoError(t, err)
	assert.Equal(t, "https://staging.everme.evermind.ai", cfg.APIBaseURL)
	assert.Equal(t, 5*time.Second, cfg.Timeout)
}

func TestLoadConfig_EnvOverridesFile(t *testing.T) {
	root := withXDG(t)
	cfgPath := filepath.Join(root, "evercli.yaml")
	require.NoError(t, os.WriteFile(cfgPath, []byte(`api_base_url: "https://staging.everme.evermind.ai"`), 0o600))

	t.Setenv("EVERCLI_API_BASE_URL", "https://override.everme.evermind.ai")
	cfg, err := LoadConfig(cfgPath)
	require.NoError(t, err)
	assert.Equal(t, "https://override.everme.evermind.ai", cfg.APIBaseURL,
		"EVERCLI_API_BASE_URL env override must beat the config file (regression test for missing EnvKeyReplacer)")
}

func TestLoadConfig_RejectsRelativeURL(t *testing.T) {
	root := withXDG(t)
	cfgPath := filepath.Join(root, "evercli.yaml")
	require.NoError(t, os.WriteFile(cfgPath, []byte(`api_base_url: "foo"`), 0o600))

	_, err := LoadConfig(cfgPath)
	require.Error(t, err, "validate must reject non-URL values so client.New doesn't get garbage")
}

func TestLoadConfig_RejectsNonHTTPScheme(t *testing.T) {
	root := withXDG(t)
	cfgPath := filepath.Join(root, "evercli.yaml")
	require.NoError(t, os.WriteFile(cfgPath, []byte(`api_base_url: "javascript:alert(1)"`), 0o600))

	_, err := LoadConfig(cfgPath)
	require.Error(t, err, "javascript:/data:/etc URIs must be rejected")
}

func TestLoadConfig_RejectsBadTimeout(t *testing.T) {
	root := withXDG(t)
	cfgPath := filepath.Join(root, "evercli.yaml")
	require.NoError(t, os.WriteFile(cfgPath, []byte(`timeout: "soon"`), 0o600))

	_, err := LoadConfig(cfgPath)
	require.Error(t, err)
}

func TestEnsureDirs_Creates0700Dirs(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows file modes don't map to NTFS ACLs")
	}
	withXDG(t)
	cfg, err := LoadConfig("")
	require.NoError(t, err)
	require.NoError(t, cfg.EnsureDirs())

	for _, d := range []string{cfg.Paths.ConfigDir, cfg.Paths.DataDir, cfg.Paths.CacheDir} {
		info, err := os.Stat(d)
		require.NoError(t, err)
		assert.EqualValues(t, 0o700, info.Mode().Perm(), "EnsureDirs must create %s at 0700", d)
	}
}

func TestXDGPath_IgnoresRelativeEnv(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "../etc")
	t.Setenv("XDG_DATA_HOME", "")
	t.Setenv("XDG_CACHE_HOME", "")
	defer func() {
		_ = os.Unsetenv("XDG_CONFIG_HOME")
	}()

	paths, err := DefaultPaths()
	require.NoError(t, err)
	// We expect the fallback (under home) instead of "../etc/evercli".
	assert.False(t, filepath.IsAbs("../etc"), "sanity")
	assert.True(t, filepath.IsAbs(paths.ConfigDir), "relative XDG values must be ignored, falling back to absolute home path")
}
