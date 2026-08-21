package conversation

import (
	"os"
	"path/filepath"
	"testing"
)

// FIX 1 — Codex evt read from config.toml [mcp_servers.everme.env].
func TestResolveEvtCodexFromConfigToml(t *testing.T) {
	dir := t.TempDir()
	cfg := `[mcp_servers.everme.env]
EVERME_AGENT_TOKEN = "evt_codex123"
`
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_HOME", dir)

	got, err := ResolveEvt(PlatformCodex)
	if err != nil {
		t.Fatal(err)
	}
	if got != "evt_codex123" {
		t.Fatalf("got %q, want evt_codex123", got)
	}
}

func TestResolveEvtCodexMissingTable(t *testing.T) {
	dir := t.TempDir()
	// config.toml exists but has no mcp_servers.everme.env table.
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte("model = \"gpt\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_HOME", dir)

	if _, err := ResolveEvt(PlatformCodex); err == nil {
		t.Fatal("expected a clear error when the everme env table is absent")
	}
}

func TestResolveEvtCodexMissingFile(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	if _, err := ResolveEvt(PlatformCodex); err == nil {
		t.Fatal("expected an error when config.toml is missing")
	}
}

// FIX 2 — OpenClaw evt read from openclaw.json plugins.entries[id].config.agentToken.
func TestResolveEvtOpenClawFromJSON(t *testing.T) {
	dir := t.TempDir()
	js := `{
  "plugins": {
    "entries": {
      "@everme/openclaw": {
        "enabled": true,
        "config": { "agentToken": "evt_oc456" }
      }
    }
  }
}`
	if err := os.WriteFile(filepath.Join(dir, "openclaw.json"), []byte(js), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENCLAW_CONFIG_DIR", dir)

	got, err := ResolveEvt(PlatformOpenClaw)
	if err != nil {
		t.Fatal(err)
	}
	if got != "evt_oc456" {
		t.Fatalf("got %q, want evt_oc456", got)
	}
}

func TestResolveEvtOpenClawMissingEntry(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "openclaw.json"), []byte(`{"plugins":{"entries":{}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENCLAW_CONFIG_DIR", dir)

	if _, err := ResolveEvt(PlatformOpenClaw); err == nil {
		t.Fatal("expected error when the everme entry is absent")
	}
}

func TestResolveEvtOpenClawMissingFile(t *testing.T) {
	t.Setenv("OPENCLAW_CONFIG_DIR", t.TempDir())
	if _, err := ResolveEvt(PlatformOpenClaw); err == nil {
		t.Fatal("expected error when openclaw.json is missing")
	}
}
