package conversation

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// epoch seconds for 2026-06-10 and 2026-06-20 (UTC midnight) used as ended_at.
// Derived via time.Date so the names match the dates (hand-written epoch
// literals were off by ~4 days, which silently defeated the on-boundary test).
var (
	ended0610 = time.Date(2026, 6, 10, 0, 0, 0, 0, time.UTC).Unix()
	ended0615 = time.Date(2026, 6, 15, 0, 0, 0, 0, time.UTC).Unix() // == --until boundary
	ended0620 = time.Date(2026, 6, 20, 0, 0, 0, 0, time.UTC).Unix()
)

func readSplitFile(t *testing.T, dir, id string) map[string]any {
	t.Helper()
	name := fmt.Sprintf("%x.json", sha256.Sum256([]byte(id)))
	b, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatalf("expected file for id %q: %v", id, err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestSplitHermesExport_MapsIdToSessionIdAndCounts(t *testing.T) {
	dir := t.TempDir()
	jsonl := fmt.Sprintf(`{"id":"sess-A","ended_at":%d,"messages":[{"role":"user","content":"hi"}]}`+"\n", ended0610)
	n, err := splitHermesExport(strings.NewReader(jsonl), dir, "")
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("want 1 session written, got %d", n)
	}
	m := readSplitFile(t, dir, "sess-A")
	if m["session_id"] != "sess-A" {
		t.Fatalf("session_id must be set from id, got %v", m["session_id"])
	}
}

func TestSplitHermesExport_SkipsInFlight(t *testing.T) {
	dir := t.TempDir()
	// ended_at omitted -> in-flight -> skipped, even with old started_at.
	jsonl := `{"id":"live","started_at":1700000000,"messages":[{"role":"user","content":"x"}]}` + "\n"
	n, err := splitHermesExport(strings.NewReader(jsonl), dir, "")
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("in-flight session must be skipped, wrote %d", n)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Fatalf("no files should be written, got %d", len(entries))
	}
}

func TestSplitHermesExport_UntilUpperBound(t *testing.T) {
	dir := t.TempDir()
	jsonl := fmt.Sprintf(
		`{"id":"old","ended_at":%d,"messages":[{"role":"user","content":"a"}]}`+"\n"+
			`{"id":"new","ended_at":%d,"messages":[{"role":"user","content":"b"}]}`+"\n",
		ended0610, ended0620)
	// until = 2026-06-15: keep only ended_at < that (old), drop new.
	n, err := splitHermesExport(strings.NewReader(jsonl), dir, "2026-06-15")
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("until upper bound should keep 1, got %d", n)
	}
	readSplitFile(t, dir, "old") // present
	newName := fmt.Sprintf("%x.json", sha256.Sum256([]byte("new")))
	if _, err := os.Stat(filepath.Join(dir, newName)); !os.IsNotExist(err) {
		t.Fatal("session after until must be dropped")
	}
}

func TestSplitHermesExport_MaliciousIdStaysInDir(t *testing.T) {
	dir := t.TempDir()
	jsonl := fmt.Sprintf(`{"id":"../../etc/passwd","ended_at":%d,"messages":[{"role":"user","content":"x"}]}`+"\n", ended0610)
	n, err := splitHermesExport(strings.NewReader(jsonl), dir, "")
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("want 1, got %d", n)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("exactly one file expected inside destDir, got %d", len(entries))
	}
	// sha256 hex name => no path separators, stays in destDir.
	if strings.ContainsAny(entries[0].Name(), "/\\") {
		t.Fatalf("filename must be path-safe, got %q", entries[0].Name())
	}
}

func TestSplitHermesExport_SetsMtimeToEndedAt(t *testing.T) {
	dir := t.TempDir()
	jsonl := fmt.Sprintf(`{"id":"sess-A","ended_at":%d,"messages":[{"role":"user","content":"hi"}]}`+"\n", ended0610)
	if _, err := splitHermesExport(strings.NewReader(jsonl), dir, ""); err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("%x.json", sha256.Sum256([]byte("sess-A")))
	fi, err := os.Stat(filepath.Join(dir, name))
	if err != nil {
		t.Fatal(err)
	}
	if got := fi.ModTime().UTC(); got != time.Unix(ended0610, 0).UTC() {
		t.Fatalf("mtime should equal ended_at, got %v", got)
	}
}

func TestSplitHermesExport_UntilExactBoundaryDropped(t *testing.T) {
	dir := t.TempDir()
	// ended_at exactly == until -> must be dropped (strict upper bound: keep only < until).
	jsonl := fmt.Sprintf(`{"id":"exact","ended_at":%d,"messages":[{"role":"user","content":"x"}]}`+"\n", ended0615)
	n, err := splitHermesExport(strings.NewReader(jsonl), dir, "2026-06-15")
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("on-boundary session must be dropped, got %d", n)
	}
}

func TestShouldBridgeHermes(t *testing.T) {
	hermesOnly := []PlatformID{PlatformHermes}
	mixed := []PlatformID{PlatformClaudeCode, PlatformHermes}
	noHermes := []PlatformID{PlatformClaudeCode}

	if !ShouldBridgeHermes(hermesOnly, nil) {
		t.Fatal("hermes in scope, no override -> should bridge")
	}
	if !ShouldBridgeHermes(mixed, map[PlatformID][]string{PlatformCodex: {"/x"}}) {
		t.Fatal("hermes in scope, unrelated override -> should bridge")
	}
	if ShouldBridgeHermes(noHermes, nil) {
		t.Fatal("hermes not in scope -> no bridge")
	}
	if ShouldBridgeHermes(hermesOnly, map[PlatformID][]string{PlatformHermes: {"/custom"}}) {
		t.Fatal("--path hermes= override -> bypass bridge")
	}
}

func TestMaterializeHermes_NoStateDB(t *testing.T) {
	home := t.TempDir() // empty, no state.db
	t.Setenv("EVERCLI_HERMES_CONFIG_DIR", home)
	t.Setenv("EVERCLI_HERMES_CMD", "/bin/echo") // binary exists but db doesn't
	_, err := MaterializeHermes("")
	if err == nil {
		t.Fatal("expected error when state.db is absent")
	}
}

func TestMaterializeHermes_NoBinary(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "state.db"), []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("EVERCLI_HERMES_CONFIG_DIR", home)
	t.Setenv("EVERCLI_HERMES_CMD", "definitely-not-a-real-binary-xyz")
	_, err := MaterializeHermes("")
	if err == nil {
		t.Fatal("expected error when hermes binary is not on PATH")
	}
}

func TestMaterializeHermes_HappyPathWithFakeExport(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "state.db"), []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	// Fake `hermes`: ignores args except the last (output path) and writes one
	// JSONL line there. `hermes sessions export <path>` => last arg is <path>.
	fake := filepath.Join(t.TempDir(), "fake-hermes.sh")
	script := "#!/bin/sh\n" +
		"for last; do :; done\n" +
		`printf '{"id":"s1","ended_at":1781395200,"messages":[{"role":"user","content":"hi"}]}\n' > "$last"` + "\n"
	if err := os.WriteFile(fake, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("EVERCLI_HERMES_CONFIG_DIR", home)
	t.Setenv("EVERCLI_HERMES_CMD", fake)

	m, err := MaterializeHermes("")
	if err != nil {
		t.Fatal(err)
	}
	defer m.Cleanup()
	if m.SessionCount != 1 {
		t.Fatalf("want 1 session materialized, got %d", m.SessionCount)
	}
	// HermesScanner should now parse the temp dir end to end.
	items, err := NewHermesScanner().Scan([]string{m.Dir})
	if err != nil || len(items) != 1 {
		t.Fatalf("scanner should find 1 item, got %d err=%v", len(items), err)
	}
	conv, err := NewHermesScanner().Read(items[0])
	if err != nil {
		t.Fatal(err)
	}
	if conv.Item.OriginID != "s1" {
		t.Fatalf("OriginID must come from session_id, got %q", conv.Item.OriginID)
	}

	m.Cleanup()
	if _, err := os.Stat(m.Dir); !os.IsNotExist(err) {
		t.Fatal("Cleanup must remove the temp dir")
	}
}
