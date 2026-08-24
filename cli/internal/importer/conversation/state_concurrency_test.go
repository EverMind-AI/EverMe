package conversation

import (
	"fmt"
	"strings"
	"sync"
	"testing"
)

// Reproduction: many concurrent Save() to the same path share a fixed
// "<path>.tmp" temp file. Two writers open+truncate the same inode and write
// different-length content from offset 0; the longer writer's tail can survive
// past the shorter writer's end → a corrupt, double-object file.
func TestStateSaveConcurrentNoCorruption(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/state.json"
	const writers = 40
	var wg sync.WaitGroup
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			s := &State{path: path, Entries: map[string]entry{}}
			// vary content length per writer so overwrite-without-truncate shows
			for j := 0; j <= n; j++ {
				s.Entries[fmt.Sprintf("k-%03d-%s", j, strings.Repeat("x", n))] =
					entry{Status: "submitted", ConversationID: strings.Repeat("y", n)}
			}
			_ = s.Save()
		}(i)
	}
	wg.Wait()
	if _, err := LoadState(path, ""); err != nil {
		t.Fatalf("state file corrupted by concurrent Save: %v", err)
	}
}
