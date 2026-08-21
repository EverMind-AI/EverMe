package conversation

import "testing"

func TestPlatformIDKnown(t *testing.T) {
	for _, p := range []PlatformID{PlatformClaudeCode, PlatformCodex, PlatformHermes, PlatformOpenClaw, PlatformMarkdown} {
		if p == "" {
			t.Fatalf("empty platform id")
		}
	}
}
