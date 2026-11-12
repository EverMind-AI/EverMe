package conversation

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeSeekMoonSession lays out one workspace the way the desktop does:
// <ws>/.openseek/sessions/<id>/openseek_session-<id>.jsonl plus the session's
// non-transcript neighbours.
func writeSeekMoonSession(t *testing.T, ws, id, body string) string {
	t.Helper()
	dir := filepath.Join(ws, ".openseek", "sessions", id)
	for _, sub := range []string{"jobs", "scratch"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o700); err != nil {
			t.Fatalf("mkdir %s: %v", sub, err)
		}
	}
	path := filepath.Join(dir, "openseek_session-"+id+".jsonl")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write transcript: %v", err)
	}
	// Neighbours that must never be mistaken for a transcript.
	for name, content := range map[string]string{
		"prediction.json":  `{"predicted":[]}`,
		"session.lock":     "",
		"jobs/uuid-1.json": `{"id":"job"}`,
		"scratch/notes.md": "# scratch",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	return path
}

func TestSeekMoonScanFindsOnlyTranscripts(t *testing.T) {
	ws := t.TempDir()
	path := writeSeekMoonSession(t, ws, "desktop-1", `{"version":1,"id":"desktop-1"}`+"\n")

	items, err := NewSeekMoonScanner().Scan([]string{filepath.Join(ws, ".openseek", "sessions")})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("want 1 item, got %d: %+v", len(items), items)
	}
	item := items[0]
	if item.Platform != PlatformSeekMoon {
		t.Errorf("platform = %q", item.Platform)
	}
	if item.Path != path {
		t.Errorf("path = %q, want %q", item.Path, path)
	}
	if item.Status != "ready" {
		t.Errorf("status = %q, want ready", item.Status)
	}
	if item.SizeBytes == 0 {
		t.Error("SizeBytes not set")
	}

	// A missing root is not an error.
	missing, err := NewSeekMoonScanner().Scan([]string{filepath.Join(ws, "nope")})
	if err != nil {
		t.Fatalf("Scan(missing): %v", err)
	}
	if len(missing) != 0 {
		t.Errorf("want no items for a missing root, got %d", len(missing))
	}
}

func TestSeekMoonReadMapsRecords(t *testing.T) {
	path := filepath.Join("testdata", "seekmoon_sample.jsonl")
	conv, err := NewSeekMoonScanner().Read(Item{Platform: PlatformSeekMoon, Path: path})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(conv.Messages) != 3 {
		t.Fatalf("want 3 messages (user, assistant, tool), got %d: %+v", len(conv.Messages), conv.Messages)
	}

	user := conv.Messages[0]
	if user.Role != "user" || user.Content != "how do I ship a release?" {
		t.Errorf("user message = %+v", user)
	}
	if user.Timestamp != 1767225600000 {
		t.Errorf("user ts = %d", user.Timestamp)
	}

	assistant := conv.Messages[1]
	if assistant.Role != "assistant" || assistant.Content != "Tag it, then push the tag." {
		t.Errorf("assistant message = %+v", assistant)
	}
	if len(assistant.ToolCalls) != 1 {
		t.Fatalf("want 1 tool call, got %d", len(assistant.ToolCalls))
	}
	call := assistant.ToolCalls[0]
	if call.ID != "call_00_tag" || call.Name != "shell" || call.Type != "function" {
		t.Errorf("tool call = %+v", call)
	}
	if !strings.Contains(call.Arguments, "git tag v1.0.0") {
		t.Errorf("tool arguments = %q", call.Arguments)
	}

	tool := conv.Messages[2]
	if tool.Role != "tool" || tool.ToolCallID != "call_00_tag" || tool.Content != "tagged" {
		t.Errorf("tool result = %+v", tool)
	}

	// runtime_notice and terminal are app bookkeeping, not conversation.
	for _, m := range conv.Messages {
		if s, ok := m.Content.(string); ok && strings.Contains(s, "background job finished") {
			t.Errorf("runtime_notice leaked into the conversation: %+v", m)
		}
	}

	// The id comes from the header, so re-imports address the same session.
	want := ConversationID(PlatformSeekMoon, "desktop-20260101-000000-000-000000001", path)
	if conv.ID != want {
		t.Errorf("conversation id = %q, want %q", conv.ID, want)
	}
	if !strings.HasPrefix(conv.ID, "import-seekmoon-desktop-20260101") {
		t.Errorf("conversation id = %q", conv.ID)
	}
	if conv.Item.StartedAt == "" {
		t.Error("StartedAt not set from messages")
	}
}

func TestSeekMoonReadToleratesJunk(t *testing.T) {
	body := strings.Join([]string{
		`{"version":1,"id":"desktop-2"}`,
		`not json at all`,
		`{"sequence":1,"ts":1767225600000,"item":{"kind":"user","payload":{"content":"hi"}}}`,
		`{"sequence":2,"ts":1767225601000,"item":{"kind":"mystery","payload":{}}}`,
		`{"sequence":3,"ts":1767225602000,"item":{"kind":"tool_result","payload":{"content":"orphan"}}}`,
		`{"sequence":4,"ts":1767225603000,"item":{"kind":"assistant","payload":{"content":"","reasoning_content":"only thinking"}}}`,
	}, "\n")
	path := filepath.Join(t.TempDir(), "openseek_session-desktop-2.jsonl")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	conv, err := NewSeekMoonScanner().Read(Item{Platform: PlatformSeekMoon, Path: path})
	if err != nil {
		t.Fatalf("Read must tolerate junk: %v", err)
	}
	if len(conv.Messages) != 1 || conv.Messages[0].Content != "hi" {
		t.Fatalf("want only the user message, got %+v", conv.Messages)
	}
	if len(conv.Warnings) != 3 {
		t.Fatalf("want 3 warnings (bad json, unknown kind, orphan tool_result), got %d: %v", len(conv.Warnings), conv.Warnings)
	}
	joined := strings.Join(conv.Warnings, "\n")
	for _, want := range []string{"json decode error", "unknown record kind", "missing tool_call_id"} {
		if !strings.Contains(joined, want) {
			t.Errorf("warnings missing %q: %v", want, conv.Warnings)
		}
	}
}

func TestSeekMoonDefaultRootsUseWorkspaceRegistry(t *testing.T) {
	homeDir := t.TempDir()
	registry := `{"workspaces":["/ws/one","/ws/two"],"initialized":true}`
	if err := os.WriteFile(filepath.Join(homeDir, "workspaces.json"), []byte(registry), 0o600); err != nil {
		t.Fatalf("write registry: %v", err)
	}
	t.Setenv("EVERCLI_SEEKMOON_HOME", homeDir)
	t.Setenv("EVERCLI_SEEKMOON_WORKSPACES", "")

	roots := DefaultRoots(PlatformSeekMoon)
	want := []string{
		filepath.Join("/ws/one", ".openseek", "sessions"),
		filepath.Join("/ws/two", ".openseek", "sessions"),
	}
	if len(roots) != len(want) {
		t.Fatalf("roots = %v, want %v", roots, want)
	}
	for i := range want {
		if roots[i] != want[i] {
			t.Errorf("roots[%d] = %q, want %q", i, roots[i], want[i])
		}
	}

	// The env override wins, which is what tests and unusual layouts use.
	t.Setenv("EVERCLI_SEEKMOON_WORKSPACES", strings.Join([]string{"/ws/three", "/ws/four"}, string(os.PathListSeparator)))
	roots = DefaultRoots(PlatformSeekMoon)
	if len(roots) != 2 || roots[0] != filepath.Join("/ws/three", ".openseek", "sessions") {
		t.Errorf("override roots = %v", roots)
	}
}

func TestResolveSeekMoonEvt(t *testing.T) {
	t.Run("reads the token from the mcp entry", func(t *testing.T) {
		runtimeDir := t.TempDir()
		t.Setenv("EVERCLI_SEEKMOON_CONFIG_DIR", runtimeDir)
		cfg := `{"mcpServers":{
			"seekmoon":{"url":"http://127.0.0.1:1/mcp"},
			"everme-memory":{"command":"npx","args":["-y","@everme/memory-mcp@latest"],
				"env":{"EVERME_API_BASE":"https://api.test","EVERME_AGENT_ID":"agt_x","EVERME_AGENT_TOKEN":" evt_test "}}}}`
		if err := os.WriteFile(filepath.Join(runtimeDir, "host-mcp.json"), []byte(cfg), 0o600); err != nil {
			t.Fatalf("write config: %v", err)
		}

		tok, err := ResolveEvt(PlatformSeekMoon)
		if err != nil {
			t.Fatalf("ResolveEvt: %v", err)
		}
		if tok != "evt_test" {
			t.Errorf("token = %q (must be trimmed)", tok)
		}
	})

	t.Run("missing entry explains how to get one", func(t *testing.T) {
		runtimeDir := t.TempDir()
		t.Setenv("EVERCLI_SEEKMOON_CONFIG_DIR", runtimeDir)
		cfg := `{"mcpServers":{"seekmoon":{"url":"http://127.0.0.1:1/mcp"}}}`
		if err := os.WriteFile(filepath.Join(runtimeDir, "host-mcp.json"), []byte(cfg), 0o600); err != nil {
			t.Fatalf("write config: %v", err)
		}

		_, err := ResolveEvt(PlatformSeekMoon)
		if err == nil {
			t.Fatal("want an error when the everme-memory entry is missing")
		}
		for _, want := range []string{"evercli plugin install seekmoon", "EVERME_AGENT_TOKEN", "host-mcp.json"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("error %q must mention %q", err.Error(), want)
			}
		}
	})

	t.Run("empty token is reported", func(t *testing.T) {
		runtimeDir := t.TempDir()
		t.Setenv("EVERCLI_SEEKMOON_CONFIG_DIR", runtimeDir)
		cfg := `{"mcpServers":{"everme-memory":{"env":{"EVERME_AGENT_TOKEN":"  "}}}}`
		if err := os.WriteFile(filepath.Join(runtimeDir, "host-mcp.json"), []byte(cfg), 0o600); err != nil {
			t.Fatalf("write config: %v", err)
		}

		_, err := ResolveEvt(PlatformSeekMoon)
		if err == nil || !strings.Contains(err.Error(), "EVERME_AGENT_TOKEN is empty") {
			t.Fatalf("want an empty-token error, got %v", err)
		}
	})
}

// The platform must be discoverable by the CLI and by the default registry,
// otherwise `--platform seekmoon` is rejected before any scan happens.
func TestSeekMoonPlatformIsRegistered(t *testing.T) {
	if !IsKnownPlatform(PlatformSeekMoon) {
		t.Error("seekmoon is not a known platform")
	}
	if !strings.Contains(PlatformList(), "seekmoon") {
		t.Errorf("PlatformList() = %q", PlatformList())
	}
	if ids, err := ParsePlatforms([]string{"seekmoon"}); err != nil || len(ids) != 1 || ids[0] != PlatformSeekMoon {
		t.Errorf("ParsePlatforms(seekmoon) = %v, %v", ids, err)
	}
	if DefaultRegistry().ScannerFor(PlatformSeekMoon) == nil {
		t.Error("DefaultRegistry has no seekmoon scanner")
	}
	// A scan of an unknown platform still fails with the full list.
	if _, err := ParsePlatforms([]string{"nope"}); err == nil {
		t.Error("unknown platform must be rejected")
	} else if !strings.Contains(err.Error(), "seekmoon") {
		t.Errorf("rejection message must list the platforms: %v", err)
	}
	// Sanity: the fixture parses as JSON, so a broken testdata file fails here
	// rather than as a mysterious warning during Read.
	raw, err := os.ReadFile(filepath.Join("testdata", "seekmoon_sample.jsonl"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	for i, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		var v any
		if err := json.Unmarshal([]byte(line), &v); err != nil {
			t.Errorf("fixture line %d is not JSON: %v", i+1, err)
		}
	}
}
