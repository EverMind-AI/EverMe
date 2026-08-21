package conversation

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ClaudeCodeScanner parses Claude Code JSONL session files.
// Each line is a JSON object wrapping a "message" field with role/content.
// user content blocks: text → user message, tool_result → role=tool message.
// assistant content blocks: text → assistant message, tool_use → toolCalls[].
type ClaudeCodeScanner struct{}

var _ Scanner = (*ClaudeCodeScanner)(nil)

func NewClaudeCodeScanner() *ClaudeCodeScanner { return &ClaudeCodeScanner{} }

func (s *ClaudeCodeScanner) Platform() PlatformID { return PlatformClaudeCode }

func (s *ClaudeCodeScanner) Scan(roots []string) ([]Item, error) {
	var items []Item
	for _, root := range roots {
		if _, err := os.Stat(root); os.IsNotExist(err) {
			continue
		}
		err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			if !strings.HasSuffix(path, ".jsonl") {
				return nil
			}
			info, err := d.Info()
			if err != nil || info == nil {
				return nil // skip unreadable entry
			}
			item := Item{
				Platform:  PlatformClaudeCode,
				Path:      path,
				Status:    "ready",
				SizeBytes: info.Size(),
				UpdatedAt: info.ModTime().UTC().Format(time.RFC3339),
			}
			items = append(items, item)
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return items, nil
}

func (s *ClaudeCodeScanner) Read(item Item) (*Conversation, error) {
	f, err := os.Open(item.Path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	conv := &Conversation{Item: item}
	scanner := bufio.NewScanner(f)
	buf := make([]byte, 0, 1024*1024)
	scanner.Buffer(buf, 64*1024*1024)
	// Use file mtime as deterministic fallback base — never time.Now() (breaks idempotency).
	var fallbackBase int64
	if fi, err := os.Stat(item.Path); err == nil {
		fallbackBase = fi.ModTime().UnixMilli()
	} else {
		fallbackBase = time.Unix(0, 0).UnixMilli()
	}
	lineNum := 0
	originID := ""

	const maxRunes = 8000

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		lineNum++
		var ev map[string]any
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			conv.Warnings = append(conv.Warnings, fmt.Sprintf("line %d: json decode error: %v", lineNum, err))
			continue
		}

		// Extract sessionId for originID
		if originID == "" {
			if sid, ok := ev["sessionId"].(string); ok && sid != "" {
				originID = sid
			}
		}

		// Claude Code embeds the turn inside ev["message"]
		inner := objectMapCC(ev["message"])
		role := stringFieldCC(inner, "role")
		if role == "" {
			role = stringFieldCC(ev, "role")
		}
		if role == "" {
			role = stringFieldCC(ev, "type")
		}
		content, ok := inner["content"]
		if !ok {
			content = ev["content"]
		}
		ts := normalizeTimestampCC(firstPresentCC(ev["timestamp"], inner["timestamp"]), fallbackBase+int64(lineNum))

		switch role {
		case "user":
			// Extract tool_result blocks first
			toolMsgs, dropped := toolResultsFromContentCC(content, ts, maxRunes)
			for range dropped {
				conv.Warnings = append(conv.Warnings, fmt.Sprintf("line %d: tool_result missing tool_use_id, dropped", lineNum))
			}
			conv.Messages = append(conv.Messages, toolMsgs...)
			// Then extract text
			if text := textFromContentCC(content, maxRunes); text != "" {
				conv.Messages = append(conv.Messages, AgentMemoryMessage{
					Role:      "user",
					Timestamp: ts,
					Content:   Redact(text),
				})
			}
		case "assistant":
			m, calls := assistantMessageFromContentCC(content, ts, maxRunes)
			if m != nil {
				conv.Messages = append(conv.Messages, *m)
				_ = calls
			}
		default:
			if role != "" {
				conv.Warnings = append(conv.Warnings, fmt.Sprintf("line %d: unknown role %q, skipped", lineNum, role))
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	setStartedAtFromMessages(conv)
	conv.ID = ConversationID(PlatformClaudeCode, originID, item.Path)
	return conv, nil
}

func assistantMessageFromContentCC(content any, timestamp int64, maxRunes int) (*AgentMemoryMessage, int) {
	if s, ok := content.(string); ok {
		s = truncateRunesCC(strings.TrimSpace(s), maxRunes)
		if s == "" {
			return nil, 0
		}
		return &AgentMemoryMessage{Role: "assistant", Timestamp: timestamp, Content: Redact(s)}, 0
	}
	blocks, ok := content.([]any)
	if !ok {
		return nil, 0
	}
	var textParts []string
	var calls []AgentMemoryToolCall
	for i, raw := range blocks {
		b := objectMapCC(raw)
		if b == nil {
			continue
		}
		switch stringFieldCC(b, "type") {
		case "text":
			if text := stringFieldCC(b, "text"); text != "" {
				textParts = append(textParts, truncateRunesCC(text, maxRunes))
			}
		case "tool_use", "toolCall":
			args, ok := b["input"]
			if !ok {
				args = b["arguments"]
			}
			id := firstNonEmptyCC(stringFieldCC(b, "id"), stringFieldCC(b, "tool_use_id"), fmt.Sprintf("claude_tool_%d_%d", timestamp, i))
			name := firstNonEmptyCC(stringFieldCC(b, "name"), "unknown")
			calls = append(calls, AgentMemoryToolCall{
				ID:        id,
				Type:      "function",
				Name:      name,
				Arguments: Redact(argumentsStringCC(args)),
			})
		}
	}
	m := AgentMemoryMessage{Role: "assistant", Timestamp: timestamp}
	if text := strings.TrimSpace(strings.Join(textParts, "\n\n")); text != "" {
		m.Content = Redact(text)
	}
	if len(calls) > 0 {
		m.ToolCalls = calls
	}
	if m.Content == nil && len(m.ToolCalls) == 0 {
		return nil, 0
	}
	return &m, len(calls)
}

func toolResultsFromContentCC(content any, timestamp int64, maxRunes int) ([]AgentMemoryMessage, int) {
	blocks, ok := content.([]any)
	if !ok {
		return nil, 0
	}
	var out []AgentMemoryMessage
	dropped := 0
	for _, raw := range blocks {
		b := objectMapCC(raw)
		if b == nil || stringFieldCC(b, "type") != "tool_result" {
			continue
		}
		toolCallID := firstNonEmptyCC(stringFieldCC(b, "tool_use_id"), stringFieldCC(b, "toolCallId"), stringFieldCC(b, "tool_call_id"))
		if toolCallID == "" {
			dropped++
			continue
		}
		text := contentTextCC(b["content"], maxRunes)
		if text == "" {
			text = "tool result"
		}
		out = append(out, AgentMemoryMessage{Role: "tool", Timestamp: timestamp, ToolCallID: toolCallID, Content: Redact(text)})
	}
	return out, dropped
}

func textFromContentCC(content any, maxRunes int) string {
	if s, ok := content.(string); ok {
		return truncateRunesCC(strings.TrimSpace(s), maxRunes)
	}
	blocks, ok := content.([]any)
	if !ok {
		return ""
	}
	parts := make([]string, 0, len(blocks))
	for _, raw := range blocks {
		if s, ok := raw.(string); ok {
			parts = append(parts, s)
			continue
		}
		b := objectMapCC(raw)
		if b == nil || stringFieldCC(b, "type") != "text" {
			continue
		}
		if text := stringFieldCC(b, "text"); text != "" {
			parts = append(parts, text)
		}
	}
	return truncateRunesCC(strings.TrimSpace(strings.Join(parts, "\n")), maxRunes)
}

func contentTextCC(v any, maxRunes int) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return truncateRunesCC(strings.TrimSpace(x), maxRunes)
	case []any:
		parts := make([]string, 0, len(x))
		for _, item := range x {
			if s, ok := item.(string); ok {
				parts = append(parts, s)
				continue
			}
			m := objectMapCC(item)
			if m != nil && stringFieldCC(m, "type") == "text" && stringFieldCC(m, "text") != "" {
				parts = append(parts, stringFieldCC(m, "text"))
				continue
			}
		}
		return truncateRunesCC(strings.TrimSpace(strings.Join(parts, "\n")), maxRunes)
	default:
		b, _ := json.Marshal(v)
		return truncateRunesCC(string(b), maxRunes)
	}
}

func objectMapCC(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func stringFieldCC(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	if s, ok := m[key].(string); ok {
		return s
	}
	return ""
}

func firstPresentCC(vals ...any) any {
	for _, v := range vals {
		if v != nil {
			return v
		}
	}
	return nil
}

func firstNonEmptyCC(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func normalizeTimestampCC(v any, fallback int64) int64 {
	switch x := v.(type) {
	case float64:
		if x > 10_000_000_000 {
			return int64(x)
		}
		if x > 0 {
			return int64(x * 1000)
		}
	case int64:
		if x > 10_000_000_000 {
			return x
		}
		if x > 0 {
			return x * 1000
		}
	case string:
		if t, err := time.Parse(time.RFC3339Nano, x); err == nil {
			return t.UnixMilli()
		}
		if t, err := time.Parse(time.RFC3339, x); err == nil {
			return t.UnixMilli()
		}
	}
	return fallback
}

func argumentsStringCC(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	if v == nil {
		return "{}"
	}
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(b)
}

// setStartedAtFromMessages sets conv.Item.StartedAt to the earliest message
// timestamp (RFC3339, UTC) found in the parsed conversation. Timestamps are
// epoch milliseconds. No-op if there are no messages with a positive ts.
func setStartedAtFromMessages(conv *Conversation) {
	var earliest int64
	for _, m := range conv.Messages {
		if m.Timestamp <= 0 {
			continue
		}
		if earliest == 0 || m.Timestamp < earliest {
			earliest = m.Timestamp
		}
	}
	if earliest == 0 {
		return
	}
	conv.Item.StartedAt = time.UnixMilli(earliest).UTC().Format(time.RFC3339)
}

// truncateRunesCC truncates s to at most max runes (the server rejects message
// content over its rune cap). It keeps the HEAD and TAIL with a middle marker
// (head_ratio 0.7) instead of head-only clipping: the case/skill extractor
// mines tool results and final responses for findings that often live at the
// END of a long message (final result, exit status, root-cause line), so the
// tail must survive. Mirrors the server extractor's _truncate_text(0.7).
func truncateRunesCC(s string, max int) string {
	if max <= 0 {
		return s
	}
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	const headRatio = 0.7
	const trimTmpl = "\n[... trimmed %d runes by evercli import ...]\n"
	// Reserve marker space using len(r) as an upper bound on the trimmed
	// count, so the real marker (fewer digits) can only be shorter — the
	// final string is therefore guaranteed <= max runes.
	markerBudget := len([]rune(fmt.Sprintf(trimTmpl, len(r))))
	budget := max - markerBudget
	if budget < 1 {
		// Cap too small to fit head+tail+marker; fall back to a plain head clip.
		return string(r[:max])
	}
	head := int(float64(budget) * headRatio)
	tail := budget - head
	trimmed := len(r) - head - tail
	marker := fmt.Sprintf(trimTmpl, trimmed)
	return string(r[:head]) + marker + string(r[len(r)-tail:])
}
