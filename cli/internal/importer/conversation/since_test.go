package conversation

import "testing"

func TestValidateSince(t *testing.T) {
	if err := ValidateSince(""); err != nil {
		t.Fatalf("empty since must be valid (no filter): %v", err)
	}
	if err := ValidateSince("2026-06-01"); err != nil {
		t.Fatalf("YYYY-MM-DD must be valid: %v", err)
	}
	if err := ValidateSince("2026/06/01"); err == nil {
		t.Fatalf("non YYYY-MM-DD must error")
	}
	if err := ValidateSince("garbage"); err == nil {
		t.Fatalf("garbage must error")
	}
}

func TestFilterItemsSince(t *testing.T) {
	items := []Item{
		{Path: "old", StartedAt: "2026-05-01T10:00:00Z"},
		{Path: "boundary", StartedAt: "2026-06-01T00:00:00Z"},
		{Path: "new", StartedAt: "2026-06-15T09:00:00Z"},
		{Path: "fallback", StartedAt: "", UpdatedAt: "2026-06-10T00:00:00Z"},
		{Path: "nodate", StartedAt: "", UpdatedAt: ""},
	}

	// Empty since: no filtering, returns all.
	if got := FilterItemsSince(items, ""); len(got) != len(items) {
		t.Fatalf("empty since must return all %d, got %d", len(items), len(got))
	}

	got := FilterItemsSince(items, "2026-06-01")
	gotPaths := map[string]bool{}
	for _, it := range got {
		gotPaths[it.Path] = true
	}
	// boundary is inclusive; old is dropped; fallback uses UpdatedAt; nodate dropped.
	want := []string{"boundary", "new", "fallback"}
	if len(got) != len(want) {
		t.Fatalf("want %v, got %d items: %v", want, len(got), gotPaths)
	}
	for _, w := range want {
		if !gotPaths[w] {
			t.Fatalf("expected %q to be kept; got %v", w, gotPaths)
		}
	}
	if gotPaths["old"] || gotPaths["nodate"] {
		t.Fatalf("old/nodate must be dropped; got %v", gotPaths)
	}
}
