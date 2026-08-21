package plugin

import (
	"embed"
	"os"
	"path/filepath"

	"evercli/internal/output"
)

// ravenFS embeds the Python MemoryBackend source-of-truth. go:embed
// cannot reach outside the package dir, so the plugin files live under
// ravenassets/everme-memory/ in this package. Tests in
// ravenassets/tests/ are deliberately NOT embedded.
//
//go:embed ravenassets/everme-memory/raven-plugin.toml ravenassets/everme-memory/README.md ravenassets/everme-memory/everme_raven/__init__.py ravenassets/everme-memory/everme_raven/backend.py ravenassets/everme-memory/everme_raven/client.py ravenassets/everme-memory/everme_raven/config.py
var ravenFS embed.FS

// ravenFileNames is the set written into
// ~/.raven/plugins/everme-memory/, relative to the plugin dir.
var ravenFileNames = []string{
	"raven-plugin.toml",
	"README.md",
	"everme_raven/__init__.py",
	"everme_raven/backend.py",
	"everme_raven/client.py",
	"everme_raven/config.py",
}

// writeRavenPluginFiles materializes the embedded everme-memory/ plugin
// into destDir/everme-memory/. destDir is typically ~/.raven/plugins.
// The subdirectory name equals RavenPluginID — Raven's discovery scans
// <user_dir>/<plugin_id>/raven-plugin.toml and warns on a mismatch.
func writeRavenPluginFiles(destDir string) error {
	pkgDir := filepath.Join(destDir, RavenPluginID)
	if err := os.MkdirAll(filepath.Join(pkgDir, "everme_raven"), 0o755); err != nil {
		return output.IOErr(pkgDir, "mkdir-plugin", err)
	}
	for _, name := range ravenFileNames {
		data, err := ravenFS.ReadFile("ravenassets/everme-memory/" + name)
		if err != nil {
			return output.Internal(err)
		}
		dst := filepath.Join(pkgDir, filepath.FromSlash(name))
		if err := writeFileAtomic(dst, data, 0o644); err != nil {
			return output.IOErr(dst, "write-plugin-file", err)
		}
	}
	return nil
}
