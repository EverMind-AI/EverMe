package plugin

import (
	"embed"
	"os"
	"path/filepath"

	"evercli/internal/output"
)

// providerFS embeds the Python MemoryProvider source-of-truth. go:embed
// cannot reach outside the package dir, so the Python files live under
// hermesassets/everme/ in this package. Tests in hermesassets/tests/ are
// deliberately NOT embedded.
//
//go:embed hermesassets/everme/__init__.py hermesassets/everme/client.py hermesassets/everme/config.py hermesassets/everme/plugin.yaml hermesassets/everme/README.md
var providerFS embed.FS

// providerFileNames is the set written into $HERMES_HOME/plugins/everme/.
var providerFileNames = []string{
	"__init__.py", "client.py", "config.py", "plugin.yaml", "README.md",
}

// writeProviderFiles materializes the embedded everme/ package into
// destDir/everme/. destDir is typically $HERMES_HOME/plugins.
func writeProviderFiles(destDir string) error {
	pkgDir := filepath.Join(destDir, "everme")
	if err := os.MkdirAll(pkgDir, 0o755); err != nil {
		return output.IOErr(pkgDir, "mkdir-provider", err)
	}
	for _, name := range providerFileNames {
		data, err := providerFS.ReadFile("hermesassets/everme/" + name)
		if err != nil {
			return output.Internal(err)
		}
		dst := filepath.Join(pkgDir, name)
		if err := writeFileAtomic(dst, data, 0o644); err != nil {
			return output.IOErr(dst, "write-provider-file", err)
		}
	}
	return nil
}
