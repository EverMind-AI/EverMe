package plugin

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWriteRavenPluginFiles(t *testing.T) {
	dest := t.TempDir()
	require.NoError(t, writeRavenPluginFiles(dest))

	pkgDir := filepath.Join(dest, RavenPluginID)
	for _, name := range ravenFileNames {
		p := filepath.Join(pkgDir, filepath.FromSlash(name))
		info, err := os.Stat(p)
		require.NoError(t, err, name)
		assert.Equal(t, os.FileMode(0o644), info.Mode().Perm(), name)
		assert.Greater(t, info.Size(), int64(0), name)
	}

	// The manifest must reference the python package we just wrote so
	// Raven's factory import resolves relative to the plugin dir.
	raw, err := os.ReadFile(filepath.Join(pkgDir, "raven-plugin.toml"))
	require.NoError(t, err)
	assert.True(t, strings.Contains(string(raw), "everme_raven.backend:make_backend"))
	_, err = os.Stat(filepath.Join(pkgDir, "everme_raven", "backend.py"))
	assert.NoError(t, err)

	// Idempotent: a second write (re-install / upgrade) must succeed.
	require.NoError(t, writeRavenPluginFiles(dest))
}
