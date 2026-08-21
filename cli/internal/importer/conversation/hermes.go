package conversation

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// HermesScanner parses Hermes session JSON files.
// Root object has: session_id, messages[].
// messages[].role: user | assistant | tool | tool_result.
// assistant messages may have tool_calls[].
// tool messages have tool_call_id.
// system_prompt is skipped.
type HermesScanner struct{}

var _ Scanner = (*HermesScanner)(nil)

func NewHermesScanner() *HermesScanner { return &HermesScanner{} }

func (s *HermesScanner) Platform() PlatformID { return PlatformHermes }

func (s *HermesScanner) Scan(roots []string) ([]Item, error) {
	var items []Item
	for _, root := range roots {
		if _, err := os.Stat(root); os.IsNotExist(err) {
			continue
		}
		err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			if !strings.HasSuffix(path, ".json") {
				return nil
			}
			info, err := d.Info()
			if err != nil || info == nil {
				return nil // skip unreadable entry
			}
			item := Item{
				Platform:  PlatformHermes,
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

func (s *HermesScanner) Read(item Item) (*Conversation, error) {
	raw, err := os.ReadFile(item.Path)
	if err != nil {
		return nil, err
	}
	var root any
	if err := json.Unmarshal(raw, &root); err != nil {
		return nil, fmt.Errorf("json decode: %w", err)
	}

	conv := &Conversation{Item: item}
	var sessionID string
	var rawMessages []any

	if obj := objectMapCC(root); obj != nil {
		sessionID = stringFieldCC(obj, "session_id")
		if arr, ok := obj["messages"].([]any); ok {
			rawMessages = arr
		}
	} else if arr, ok := root.([]any); ok {
		rawMessages = arr
	}
	if rawMessages == nil {
		return nil, fmt.Errorf("no messages array found in %s", item.Path)
	}

	// Set originID on the item from session_id
	conv.Item.OriginID = sessionID

	const maxRunes = 8000
	// Use file mtime as deterministic fallback base — never time.Now() (breaks idempotency).
	var fallbackBase int64
	if fi, err := os.Stat(item.Path); err == nil {
		fallbackBase = fi.ModTime().UnixMilli()
	} else {
		fallbackBase = time.Unix(0, 0).UnixMilli()
	}

	for i, rawMsg := range rawMessages {
		m := objectMapCC(rawMsg)
		if m == nil {
			conv.Warnings = append(conv.Warnings, fmt.Sprintf("msg[%d]: not an object, skipped", i))
			continue
		}
		role := stringFieldCC(m, "role")
		ts := normalizeTimestampCC(m["timestamp"], fallbackBase+int64(i))

		switch role {
		case "system", "system_prompt":
			// skip system prompts
		case "user":
			text := hermesContentText(m["content"], maxRunes)
			if text == "" {
				conv.Warnings = append(conv.Warnings, fmt.Sprintf("msg[%d]: user message with no text, skipped", i))
				continue
			}
			conv.Messages = append(conv.Messages, AgentMemoryMessage{
				Role:      "user",
				Timestamp: ts,
				Content:   Redact(text),
			})
		case "assistant":
			msg, calls := hermesAssistantMessage(m, ts, maxRunes)
			if msg == nil {
				conv.Warnings = append(conv.Warnings, fmt.Sprintf("msg[%d]: assistant message with no content, skipped", i))
				continue
			}
			conv.Messages = append(conv.Messages, *msg)
			_ = calls
		case "tool", "tool_result":
			toolCallID := firstNonEmptyCC(stringFieldCC(m, "tool_call_id"), stringFieldCC(m, "toolCallId"))
			if toolCallID == "" {
				conv.Warnings = append(conv.Warnings, fmt.Sprintf("msg[%d]: tool message missing tool_call_id, dropped", i))
				continue
			}
			text := hermesContentText(m["content"], maxRunes)
			if text == "" {
				text = "tool result"
			}
			conv.Messages = append(conv.Messages, AgentMemoryMessage{
				Role:       "tool",
				Timestamp:  ts,
				ToolCallID: toolCallID,
				Content:    Redact(text),
			})
		default:
			if role != "" {
				conv.Warnings = append(conv.Warnings, fmt.Sprintf("msg[%d]: unknown role %q, skipped", i, role))
			}
		}
	}

	setStartedAtFromMessages(conv)
	conv.ID = ConversationID(PlatformHermes, sessionID, item.Path)
	return conv, nil
}

func hermesAssistantMessage(m map[string]any, ts int64, maxRunes int) (*AgentMemoryMessage, int) {
	text := hermesContentText(m["content"], maxRunes)
	calls := hermesToolCalls(m, ts)

	msg := AgentMemoryMessage{Role: "assistant", Timestamp: ts}
	if text != "" {
		msg.Content = Redact(text)
	}
	if len(calls) > 0 {
		msg.ToolCalls = calls
	}
	if msg.Content == nil && len(msg.ToolCalls) == 0 {
		return nil, 0
	}
	return &msg, len(calls)
}

func hermesToolCalls(m map[string]any, ts int64) []AgentMemoryToolCall {
	var rawCalls []any
	for _, key := range []string{"tool_calls", "toolCalls"} {
		if arr, ok := m[key].([]any); ok {
			rawCalls = arr
			break
		}
	}
	if rawCalls == nil {
		return nil
	}
	var calls []AgentMemoryToolCall
	for j, raw := range rawCalls {
		b := objectMapCC(raw)
		if b == nil {
			continue
		}
		fn := objectMapCC(b["function"])
		name := stringFieldCC(fn, "name")
		var args any
		if fn != nil {
			args = fn["arguments"]
		}
		if name == "" {
			name = stringFieldCC(b, "name")
			args = b["arguments"]
		}
		id := firstNonEmptyCC(
			stringFieldCC(b, "id"),
			stringFieldCC(b, "call_id"),
			fmt.Sprintf("hermes_tool_%d_%d", ts, j),
		)
		calls = append(calls, AgentMemoryToolCall{
			ID:        id,
			Type:      "function",
			Name:      firstNonEmptyCC(name, "unknown"),
			Arguments: Redact(argumentsStringCC(args)),
		})
	}
	return calls
}

func hermesContentText(v any, maxRunes int) string {
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
			mm := objectMapCC(item)
			if mm == nil {
				continue
			}
			if text := stringFieldCC(mm, "text"); text != "" {
				parts = append(parts, text)
				continue
			}
			if text := stringFieldCC(mm, "content"); text != "" {
				parts = append(parts, text)
			}
		}
		return truncateRunesCC(strings.TrimSpace(strings.Join(parts, "\n")), maxRunes)
	case map[string]any:
		if text := stringFieldCC(x, "text"); text != "" {
			return truncateRunesCC(strings.TrimSpace(text), maxRunes)
		}
		if text := stringFieldCC(x, "content"); text != "" {
			return truncateRunesCC(strings.TrimSpace(text), maxRunes)
		}
		b, _ := json.Marshal(x)
		return truncateRunesCC(string(b), maxRunes)
	default:
		b, _ := json.Marshal(v)
		return truncateRunesCC(string(b), maxRunes)
	}
}
