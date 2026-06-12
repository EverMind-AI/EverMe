package plugin

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteProviderFiles(t *testing.T) {
	dir := t.TempDir()
	if err := writeProviderFiles(dir); err != nil {
		t.Fatalf("writeProviderFiles: %v", err)
	}
	for _, name := range []string{"__init__.py", "client.py", "config.py", "plugin.yaml", "README.md"} {
		p := filepath.Join(dir, "everme", name)
		info, err := os.Stat(p)
		if err != nil {
			t.Fatalf("missing %s: %v", name, err)
		}
		if info.Size() == 0 {
			t.Fatalf("empty %s", name)
		}
	}
	// __init__.py must contain the discovery marker.
	b, _ := os.ReadFile(filepath.Join(dir, "everme", "__init__.py"))
	if !containsStr(string(b), "register_memory_provider") {
		t.Fatal("__init__.py missing register_memory_provider marker")
	}
}

func containsStr(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(haystack); i++ {
			if haystack[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}
