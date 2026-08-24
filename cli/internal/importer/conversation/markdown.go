package conversation

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// markdownChunkBudget is the per-message rune budget when an oversize file is
// split across multiple messages. It equals the server's MaxMessageContentRunes
// so every emitted message passes per-message validation. No message-count cap
// is needed here: the Uploader batches these messages into <=maxAgentBatchBytes
// (64 KiB) POSTs under one conversationId, which is the real per-request object
// limit. So any file admitted at scan time is uploaded in full, with zero loss.
const markdownChunkBudget = 8000

// markdownMaxFileBytes is the scan-time guard: a single .md larger than this is
// skipped rather than read. It is NOT the per-request object limit — that is
// maxAgentBatchBytes (64 KiB), enforced downstream by the Uploader, which slices
// the messages this scanner emits into multiple POSTs.
const markdownMaxFileBytes = 1 << 20 // 1 MB

// markdownBlacklistDirs are directory names pruned during any markdown walk.
// Agent home dirs and project trees embed installed-software docs (dependency
// READMEs, build output) that must never be swept into memory.
var markdownBlacklistDirs = map[string]struct{}{
	".git": {}, ".hg": {}, ".svn": {},
	"node_modules": {}, ".venv": {}, "venv": {}, ".env": {},
	"__pycache__": {}, ".tox": {}, ".mypy_cache": {}, ".pytest_cache": {},
	"dist": {}, "build": {}, "target": {}, "vendor": {}, "coverage": {},
	".next": {}, ".nuxt": {}, ".gradle": {}, ".idea": {}, ".vscode": {},
}

// markdownZone is a curated scan region inside an agent home dir: depth-1
// *.md directly under personaDir (persona / identity / memory-index files)
// plus a recursive *.md walk of treeDir (the agent's memory or projects log).
// Anything outside these zones — plugin caches, vendored skills, marketplace
// docs — is intentionally never scanned.
type markdownZone struct {
	personaDir string
	treeDir    string
}

// markdownZonesForHome maps an agent home dir to its curated zones. Returns
// false when home is not a recognized agent home (e.g. a user-supplied
// --path override), in which case the caller recursive-walks it directly
// (still pruned by the blacklist + size cap).
func markdownZonesForHome(home string) (markdownZone, bool) {
	home = filepath.Clean(home)
	for p, dir := range agentHomeDirs() {
		if filepath.Clean(dir) != home {
			continue
		}
		switch p {
		case PlatformClaudeCode:
			return markdownZone{personaDir: home, treeDir: filepath.Join(home, "projects")}, true
		case PlatformOpenClaw:
			ws := filepath.Join(home, "workspace")
			return markdownZone{personaDir: ws, treeDir: filepath.Join(ws, "memory")}, true
		case PlatformCodex:
			return markdownZone{personaDir: home, treeDir: filepath.Join(home, "memories")}, true
		case PlatformHermes:
			return markdownZone{personaDir: home, treeDir: filepath.Join(home, "memories")}, true
		}
	}
	return markdownZone{}, false
}

// MarkdownScanner turns each .md file into a conversation of role=user
// messages. It redacts the whole text, then splits it into one or more messages
// of at most markdownChunkBudget runes each (no content is dropped), all sharing
// the file mtime as their base timestamp.
type MarkdownScanner struct{}

var _ Scanner = (*MarkdownScanner)(nil)

func NewMarkdownScanner() *MarkdownScanner { return &MarkdownScanner{} }

func (s *MarkdownScanner) Platform() PlatformID { return PlatformMarkdown }

func (s *MarkdownScanner) Scan(roots []string) ([]Item, error) {
	var items []Item
	seen := map[string]struct{}{}
	add := func(path string, info os.FileInfo) {
		if info.Size() > markdownMaxFileBytes {
			return
		}
		if _, dup := seen[path]; dup {
			return
		}
		seen[path] = struct{}{}
		items = append(items, Item{
			Platform:      PlatformMarkdown,
			Path:          path,
			Status:        "ready",
			SizeBytes:     info.Size(),
			UpdatedAt:     info.ModTime().UTC().Format(time.RFC3339),
			OwnerPlatform: ownerForMarkdownPath(path),
		})
	}

	for _, root := range roots {
		if zone, ok := markdownZonesForHome(root); ok {
			scanMarkdownDepth1(zone.personaDir, add)
			scanMarkdownTree(zone.treeDir, add)
			continue
		}
		// Custom --path override: recursive walk, still pruned + capped.
		scanMarkdownTree(root, add)
	}
	return items, nil
}

// scanMarkdownDepth1 collects *.md directly under dir (no recursion). Missing
// dir and symlinked entries are skipped silently.
func scanMarkdownDepth1(dir string, add func(string, os.FileInfo)) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() || e.Type()&os.ModeSymlink != 0 {
			continue
		}
		if !strings.HasSuffix(strings.ToLower(e.Name()), ".md") {
			continue
		}
		info, err := e.Info()
		if err != nil || info == nil {
			continue
		}
		add(filepath.Join(dir, e.Name()), info)
	}
}

// scanMarkdownTree recursively collects *.md under root, pruning blacklisted
// directories and not following symlinks. Missing root yields nothing.
func scanMarkdownTree(root string, add func(string, os.FileInfo)) {
	if _, err := os.Stat(root); os.IsNotExist(err) {
		return
	}
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if path != root {
				if _, blocked := markdownBlacklistDirs[strings.ToLower(d.Name())]; blocked {
					return filepath.SkipDir
				}
			}
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		if !strings.HasSuffix(strings.ToLower(path), ".md") {
			return nil
		}
		info, err := d.Info()
		if err != nil || info == nil {
			return nil
		}
		add(path, info)
		return nil
	})
}

func (s *MarkdownScanner) Read(item Item) (*Conversation, error) {
	raw, err := os.ReadFile(item.Path)
	if err != nil {
		return nil, err
	}

	// Get file mtime for timestamp
	fi, err := os.Stat(item.Path)
	if err != nil {
		return nil, err
	}
	ts := fi.ModTime().UnixMilli()

	// Redact the FULL text BEFORE splitting so a credential can't straddle a
	// chunk boundary and slip past redaction.
	text := Redact(string(raw))

	conv := &Conversation{Item: item}
	// Split into as many messages as the content needs — no message-count cap.
	// The scan-time whole-file size limit (markdownMaxFileBytes) already bounds
	// the message count, so an admitted file is uploaded in full with no loss.
	chunks := splitRunes(text, markdownChunkBudget)
	if len(chunks) > 1 {
		conv.Warnings = append(conv.Warnings,
			fmt.Sprintf("content split into %d messages", len(chunks)))
	}

	for i, c := range chunks {
		conv.Messages = append(conv.Messages, AgentMemoryMessage{
			Role:      "user",
			Timestamp: ts + int64(i), // same mtime; +i keeps order stable if sorted by ts
			Content:   c,
		})
	}
	conv.ID = ConversationID(PlatformMarkdown, "", item.Path)
	return conv, nil
}

// splitRunes splits text into chunks of at most budget runes, preferring to
// break at the last '\n' in the back 20% of a chunk so sections stay whole. A
// stretch with no newline in range is hard-split at the budget.
func splitRunes(text string, budget int) []string {
	runes := []rune(text)
	if len(runes) <= budget {
		return []string{text}
	}
	var chunks []string
	for len(runes) > budget {
		cut := budget
		lo := budget * 4 / 5
		for i := budget - 1; i >= lo; i-- {
			if runes[i] == '\n' {
				cut = i + 1 // keep the newline in this chunk
				break
			}
		}
		chunks = append(chunks, string(runes[:cut]))
		runes = runes[cut:]
	}
	if len(runes) > 0 {
		chunks = append(chunks, string(runes))
	}
	return chunks
}
