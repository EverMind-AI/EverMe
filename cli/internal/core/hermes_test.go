package core

import (
	"path/filepath"
	"testing"
)

func TestHermesHome_ConfigDirOverrideWins(t *testing.T) {
	t.Setenv("EVERCLI_HERMES_CONFIG_DIR", "/tmp/pinned-home")
	t.Setenv("HERMES_HOME", "/tmp/other")
	got, err := HermesHome()
	if err != nil {
		t.Fatal(err)
	}
	if got != "/tmp/pinned-home" {
		t.Fatalf("EVERCLI_HERMES_CONFIG_DIR must win, got %q", got)
	}
}

func TestHermesHome_HermesHomeEnv(t *testing.T) {
	t.Setenv("EVERCLI_HERMES_CONFIG_DIR", "")
	t.Setenv("HERMES_HOME", "/tmp/hh")
	got, err := HermesHome()
	if err != nil {
		t.Fatal(err)
	}
	if got != "/tmp/hh" {
		t.Fatalf("HERMES_HOME should resolve, got %q", got)
	}
}

func TestHermesHome_FallbackToDotHermes(t *testing.T) {
	t.Setenv("EVERCLI_HERMES_CONFIG_DIR", "")
	t.Setenv("HERMES_HOME", "")
	// EVERCLI_HERMES_CMD points to a missing binary so `hermes config path`
	// fails and we fall through to $HOME/.hermes.
	t.Setenv("EVERCLI_HERMES_CMD", "definitely-not-a-real-binary-xyz")
	t.Setenv("HOME", "/tmp/fakehome")
	got, err := HermesHome()
	if err != nil {
		t.Fatal(err)
	}
	if got != filepath.Join("/tmp/fakehome", ".hermes") {
		t.Fatalf("fallback should be $HOME/.hermes, got %q", got)
	}
}

func TestHermesCommand_EnvOverride(t *testing.T) {
	t.Setenv("EVERCLI_HERMES_CMD", "/opt/hermes")
	if got := HermesCommand(); got != "/opt/hermes" {
		t.Fatalf("expected override, got %q", got)
	}
}
