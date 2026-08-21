package conversation

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveEvtFromEnvFile(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "everme.env")
	os.WriteFile(f, []byte("EVERME_AGENT_ID=agt_x\nEVERME_AGENT_TOKEN=evt_target123\n"), 0o600)
	got, err := readAgentTokenFromEnvFile(f)
	if err != nil {
		t.Fatal(err)
	}
	if got != "evt_target123" {
		t.Fatalf("got %q", got)
	}
}

func TestResolveEvtMissing(t *testing.T) {
	_, err := readAgentTokenFromEnvFile(filepath.Join(t.TempDir(), "nope.env"))
	if err == nil {
		t.Fatal("expected error for missing file")
	}
}

func TestResolveEvtEmptyValue(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "everme.env")
	os.WriteFile(f, []byte("EVERME_AGENT_TOKEN=\n"), 0o600)
	_, err := readAgentTokenFromEnvFile(f)
	if err == nil {
		t.Fatal("expected error for empty token value")
	}
}

func TestResolveEvtExportPrefix(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "everme.env")
	os.WriteFile(f, []byte("export EVERME_AGENT_TOKEN=evt_x\n"), 0o600)
	got, err := readAgentTokenFromEnvFile(f)
	if err != nil {
		t.Fatal(err)
	}
	if got != "evt_x" {
		t.Fatalf("got %q, want %q", got, "evt_x")
	}
}

func TestResolveWorkBuddyEvt(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("EVERCLI_WORKBUDDY_CONFIG_DIR", dir)
	cfg := `{"mcpServers":{"everme-memory":{"command":"npx","args":["-y","@everme/memory-mcp@latest"],"env":{"EVERME_API_BASE":"https://api.everme.evermind.ai","EVERME_AGENT_ID":"agt_x","EVERME_AGENT_TOKEN":"evt_workbuddy123"}}}}`
	if err := os.WriteFile(filepath.Join(dir, "mcp.json"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := resolveWorkBuddyEvt()
	if err != nil {
		t.Fatal(err)
	}
	if got != "evt_workbuddy123" {
		t.Fatalf("got %q, want %q", got, "evt_workbuddy123")
	}
}

func TestResolveWorkBuddyEvtMissingEntry(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("EVERCLI_WORKBUDDY_CONFIG_DIR", dir)
	if err := os.WriteFile(filepath.Join(dir, "mcp.json"), []byte(`{"mcpServers":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := resolveWorkBuddyEvt(); err == nil {
		t.Fatal("expected error when the everme-memory entry is absent")
	}
}

func TestResolveWorkBuddyEvtViaResolveEvt(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("EVERCLI_WORKBUDDY_CONFIG_DIR", dir)
	cfg := `{"mcpServers":{"everme-memory":{"env":{"EVERME_AGENT_TOKEN":"evt_via_dispatch"}}}}`
	if err := os.WriteFile(filepath.Join(dir, "mcp.json"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := ResolveEvt(PlatformWorkBuddy)
	if err != nil {
		t.Fatal(err)
	}
	if got != "evt_via_dispatch" {
		t.Fatalf("got %q, want %q", got, "evt_via_dispatch")
	}
}
