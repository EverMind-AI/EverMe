package conversation

import (
	"fmt"
	"time"
)

// ValidateSince checks that since is empty (no filter) or a YYYY-MM-DD date.
func ValidateSince(since string) error {
	if since == "" {
		return nil
	}
	if _, err := time.Parse("2006-01-02", since); err != nil {
		return fmt.Errorf("--since must be YYYY-MM-DD, got %q", since)
	}
	return nil
}

// FilterItemsSince keeps items whose date (StartedAt, falling back to
// UpdatedAt) is on or after since (YYYY-MM-DD). An empty since returns items
// unchanged. Items without a usable date are dropped when filtering.
func FilterItemsSince(items []Item, since string) []Item {
	if since == "" {
		return items
	}
	filtered := items[:0]
	for _, item := range items {
		date := item.StartedAt
		if date == "" {
			date = item.UpdatedAt
		}
		if len(date) >= 10 && date[:10] >= since {
			filtered = append(filtered, item)
		}
	}
	return filtered
}
