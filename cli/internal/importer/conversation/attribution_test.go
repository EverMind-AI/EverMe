package conversation

import (
	"os"
	"path/filepath"
	"testing"
)

// FIX 3 — ownerForMarkdownPath maps a path under each agent home dir.
func TestOwnerForMarkdownPath(t *testing.T) {
	home := t.TempDir()
	claude := filepath.Join(home, ".claude")
	codex := filepath.Join(home, ".codex")
	hermes := filepath.Join(home, ".hermes")
	openclaw := filepath.Join(home, ".openclaw")
	t.Setenv("CLAUDE_CONFIG_DIR", claude)
	t.Setenv("CODEX_HOME", codex)
	t.Setenv("OPENCLAW_CONFIG_DIR", openclaw)
	// hermes honors HOME default; override its dir via HOME.
	t.Setenv("HOME", home)

	cases := []struct {
		path string
		want PlatformID
	}{
		{filepath.Join(claude, "notes", "a.md"), PlatformClaudeCode},
		{filepath.Join(codex, "x.md"), PlatformCodex},
		{filepath.Join(hermes, "y.md"), PlatformHermes},
		{filepath.Join(openclaw, "z.md"), PlatformOpenClaw},
		{filepath.Join(home, "Documents", "elsewhere.md"), ""},
	}
	for _, c := range cases {
		if got := ownerForMarkdownPath(c.path); got != c.want {
			t.Errorf("ownerForMarkdownPath(%q) = %q, want %q", c.path, got, c.want)
		}
	}
}

// FIX 3 — AttributionPlatform returns owner for owned md, platform otherwise.
func TestAttributionPlatform(t *testing.T) {
	if got := AttributionPlatform(Item{Platform: PlatformMarkdown, OwnerPlatform: PlatformClaudeCode}); got != PlatformClaudeCode {
		t.Errorf("owned md should attribute to owner, got %q", got)
	}
	if got := AttributionPlatform(Item{Platform: PlatformMarkdown}); got != PlatformMarkdown {
		t.Errorf("ownerless md should stay markdown, got %q", got)
	}
	if got := AttributionPlatform(Item{Platform: PlatformCodex}); got != PlatformCodex {
		t.Errorf("non-md should return its own platform, got %q", got)
	}
}

// FIX 3 — scanning an md under an agent dir sets OwnerPlatform and includes it.
func TestMarkdownScanSetsOwnerPlatform(t *testing.T) {
	home := t.TempDir()
	claude := filepath.Join(home, ".claude")
	if err := os.MkdirAll(claude, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLAUDE_CONFIG_DIR", claude)
	t.Setenv("HOME", home)

	mdPath := filepath.Join(claude, "owned.md")
	if err := os.WriteFile(mdPath, []byte("# note\nhello"), 0o644); err != nil {
		t.Fatal(err)
	}

	sc := NewMarkdownScanner()
	items, err := sc.Scan([]string{claude})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(items))
	}
	if items[0].OwnerPlatform != PlatformClaudeCode {
		t.Fatalf("OwnerPlatform should be claude-code, got %q", items[0].OwnerPlatform)
	}
}

func TestMarkdownScanUnknownDirHasNoOwner(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude"))
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
	t.Setenv("OPENCLAW_CONFIG_DIR", filepath.Join(home, ".openclaw"))

	other := filepath.Join(home, "Documents")
	if err := os.MkdirAll(other, 0o755); err != nil {
		t.Fatal(err)
	}
	mdPath := filepath.Join(other, "loose.md")
	if err := os.WriteFile(mdPath, []byte("loose note"), 0o644); err != nil {
		t.Fatal(err)
	}

	sc := NewMarkdownScanner()
	items, err := sc.Scan([]string{other})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(items))
	}
	if items[0].OwnerPlatform != "" {
		t.Fatalf("md outside agent dirs must have empty OwnerPlatform, got %q", items[0].OwnerPlatform)
	}
}
