package imports

import (
	"bytes"
	"testing"

	"evercli/internal/importer/conversation"
	"evercli/internal/plugin"
)

// FIX 5 — an unknown platform name on `scan` is a hard error, not a silent ok.
func TestScanUnknownPlatformErrors(t *testing.T) {
	// Isolate config/data dirs so BuildDeps bootstraps against an empty home.
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())

	cmd := newConversationsScan()
	var out, errOut bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&errOut)
	cmd.SetArgs([]string{"nope"})

	err := cmd.Execute()
	if err == nil {
		t.Fatalf("unknown platform must return a non-nil error; stdout=%q stderr=%q", out.String(), errOut.String())
	}
	// The error routes through the output envelope as a non-zero exit
	// (invalid_args). Exact wording lives in the package-level ParsePlatforms
	// test; here we only assert it is a hard, non-ok failure.
}

// A known platform still succeeds (no error from validation).
func TestScanKnownPlatformOK(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())

	cmd := newConversationsScan()
	var out, errOut bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&errOut)
	cmd.SetArgs([]string{"claude-code"})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("known platform must not error: %v (stderr=%q)", err, errOut.String())
	}
}

// loadHookMarks casts plugin.Platform -> conversation.PlatformID by bare
// string, trusting the two literals stay spelled the same (see the comment
// beside that cast in conversations.go). Neither package's own registry
// test can catch a future drift on its own since importer and plugin must
// not import each other (cli/AGENTS.md); this one can, from cmd/.
func TestWorkBuddyPlatformStringMatchesPlugin(t *testing.T) {
	if string(conversation.PlatformWorkBuddy) != string(plugin.PlatformWorkBuddy) {
		t.Fatalf("conversation.PlatformWorkBuddy=%q and plugin.PlatformWorkBuddy=%q have drifted",
			conversation.PlatformWorkBuddy, plugin.PlatformWorkBuddy)
	}
}
