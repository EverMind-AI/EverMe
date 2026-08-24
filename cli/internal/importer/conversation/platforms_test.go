package conversation

import "testing"

// FIX 5 — IsKnownPlatform / ParsePlatforms reject unknown names.
func TestIsKnownPlatform(t *testing.T) {
	for _, p := range []PlatformID{PlatformClaudeCode, PlatformCodex, PlatformHermes, PlatformOpenClaw, PlatformMarkdown} {
		if !IsKnownPlatform(p) {
			t.Errorf("%q should be known", p)
		}
	}
	if IsKnownPlatform("nope") {
		t.Error("nope must not be known")
	}
}

func TestParsePlatforms(t *testing.T) {
	ids, err := ParsePlatforms([]string{" claude-code ", "codex"})
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 || ids[0] != PlatformClaudeCode || ids[1] != PlatformCodex {
		t.Fatalf("got %v", ids)
	}

	if _, err := ParsePlatforms([]string{"claude-code", "nope"}); err == nil {
		t.Fatal("unknown platform name must error")
	}
}

func TestKimicodeKnownAndRoots(t *testing.T) {
	if !IsKnownPlatform(PlatformKimicode) {
		t.Fatal("kimicode must be a known platform")
	}
	t.Setenv("KIMI_CODE_HOME", "/tmp/kc-test")
	roots := DefaultRoots(PlatformKimicode)
	if len(roots) != 1 || roots[0] != "/tmp/kc-test/sessions" {
		t.Fatalf("unexpected roots: %v", roots)
	}
	path, ok := platformEnvFile(PlatformKimicode)
	if !ok || path != "/tmp/kc-test/everme.env" {
		t.Fatalf("unexpected env file: %q ok=%v", path, ok)
	}
}
