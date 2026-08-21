package conversation

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRegistryListsAllScanners(t *testing.T) {
	r := DefaultRegistry()
	got := map[PlatformID]bool{}
	for _, sc := range r.Scanners() {
		got[sc.Platform()] = true
	}
	for _, p := range []PlatformID{PlatformClaudeCode, PlatformCodex, PlatformHermes, PlatformOpenClaw, PlatformMarkdown, PlatformWorkBuddy} {
		if !got[p] {
			t.Fatalf("registry missing %s", p)
		}
	}
}

func TestDefaultRootsHonorEnv(t *testing.T) {
	t.Setenv("CODEX_HOME", "/custom/codex")
	roots := DefaultRoots(PlatformCodex)
	found := false
	for _, r := range roots {
		if r == "/custom/codex/sessions" {
			found = true
		}
	}
	if !found {
		t.Fatalf("CODEX_HOME not honored: %v", roots)
	}
}

func TestDefaultRootsHonorClaudeConfigDir(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", "/custom/claude")
	roots := DefaultRoots(PlatformClaudeCode)
	found := false
	for _, r := range roots {
		if r == "/custom/claude/projects" {
			found = true
		}
	}
	if !found {
		t.Fatalf("CLAUDE_CONFIG_DIR not honored: %v", roots)
	}
}

// TestOpenClawRootCoversEveryAgent is the regression for the 2026-08-17
// review item 1.2.1.2. The default root was hardcoded to
// ~/.openclaw/agents/main/sessions, so a user running more than one
// OpenClaw agent had every non-main agent's history silently invisible
// to scan and run.
func TestOpenClawRootCoversEveryAgent(t *testing.T) {
	t.Setenv("OPENCLAW_CONFIG_DIR", "/custom/openclaw")
	roots := DefaultRoots(PlatformOpenClaw)
	if len(roots) != 1 || roots[0] != "/custom/openclaw/agents" {
		t.Fatalf("openclaw root must be the agents dir so every agent is walked, got %v", roots)
	}
}

// TestOpenClawScanFindsNonMainAgents proves the root change end to end:
// the scanner already walks recursively, it was only ever pointed at one
// agent's folder.
func TestOpenClawScanFindsNonMainAgents(t *testing.T) {
	home := t.TempDir()
	for _, agent := range []string{"main", "research"} {
		dir := filepath.Join(home, "agents", agent, "sessions")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		body := `{"type":"model.completed","sessionId":"s-` + agent + `","data":{"messagesSnapshot":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}}` + "\n"
		if err := os.WriteFile(filepath.Join(dir, agent+".trajectory.jsonl"), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("OPENCLAW_CONFIG_DIR", home)

	items, err := NewOpenClawScanner().Scan(DefaultRoots(PlatformOpenClaw))
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("expected one item per agent, got %d: %v", len(items), items)
	}
	seen := map[string]bool{}
	for _, it := range items {
		seen[filepath.Base(it.Path)] = true
	}
	for _, want := range []string{"main.trajectory.jsonl", "research.trajectory.jsonl"} {
		if !seen[want] {
			t.Fatalf("missing %s in scan results: %v", want, seen)
		}
	}
}
