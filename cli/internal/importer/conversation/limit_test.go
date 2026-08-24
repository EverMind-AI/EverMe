package conversation

import "testing"

func TestLimitItems(t *testing.T) {
	items := []Item{{Path: "a"}, {Path: "b"}, {Path: "c"}}

	// limit <= 0 means unlimited: return all.
	if got := LimitItems(items, 0); len(got) != 3 {
		t.Fatalf("limit 0 must return all 3, got %d", len(got))
	}
	if got := LimitItems(items, -1); len(got) != 3 {
		t.Fatalf("negative limit must return all 3, got %d", len(got))
	}

	// limit larger than len: return all.
	if got := LimitItems(items, 10); len(got) != 3 {
		t.Fatalf("limit > len must return all 3, got %d", len(got))
	}

	// limit smaller than len: return first N, in order.
	got := LimitItems(items, 2)
	if len(got) != 2 || got[0].Path != "a" || got[1].Path != "b" {
		t.Fatalf("limit 2 must return first two [a b], got %v", got)
	}
}

func TestSortItemsNewestFirst(t *testing.T) {
	items := []Item{
		{Path: "a", StartedAt: "2026-08-01T00:00:00Z"},
		{Path: "b", UpdatedAt: "2026-08-05T00:00:00Z"}, // no StartedAt → falls back
		{Path: "c", StartedAt: "2026-08-03T00:00:00Z"},
	}
	got := SortItemsNewestFirst(items)
	want := []string{"b", "c", "a"}
	for i, w := range want {
		if got[i].Path != w {
			t.Fatalf("order[%d]=%s, want %s", i, got[i].Path, w)
		}
	}
	if items[0].Path != "a" {
		t.Fatal("input slice must not be mutated")
	}
}
