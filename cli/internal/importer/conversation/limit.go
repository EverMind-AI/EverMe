package conversation

import "sort"

// LimitItems returns at most limit items (the first limit, in order). A
// limit <= 0 means unlimited and returns items unchanged.
func LimitItems(items []Item, limit int) []Item {
	if limit > 0 && len(items) > limit {
		return items[:limit]
	}
	return items
}

// SortItemsNewestFirst orders items by session date descending so --limit N
// selects the N most recent sessions rather than the first N in scan order.
// Dates are RFC3339-ish strings; lexicographic compare matches chronology.
func SortItemsNewestFirst(items []Item) []Item {
	out := make([]Item, len(items))
	copy(out, items)
	sort.SliceStable(out, func(i, j int) bool {
		return itemSortDate(out[i]) > itemSortDate(out[j])
	})
	return out
}

func itemSortDate(it Item) string {
	if it.StartedAt != "" {
		return it.StartedAt
	}
	return it.UpdatedAt
}
