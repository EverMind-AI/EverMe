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

// OpenClawScanner parses OpenClaw trajectory JSONL files.
//
// OpenClaw trajectory format (traceSchema: "openclaw-trajectory"):
// Each line is a JSON event with top-level fields:
//
//	type, ts, sessionId, data
//
// Relevant event types:
//   - model.completed: data.messagesSnapshot — the full conversation up to that turn.
//     We use the LAST model.completed event's snapshot to get the complete conversation.
//   - session.started, session.ended, trace.metadata, context.compiled,
//     prompt.submitted, trace.artifacts — metadata only, skipped.
//
// messagesSnapshot items:
//
//	role: "user" | "assistant" | "toolResult"
//	For user: content is []{"type":"text","text":"..."}
//	For assistant: content is []{"type":"text","text":"..."} | []{"type":"toolCall","id":"...","name":"...","arguments":{}}
//	For toolResult: toolCallId, content is []{"type":"text","text":"..."}
//
// The .trajectory-path.json file is a metadata pointer (session file path); not parsed here.
type OpenClawScanner struct{}

var _ Scanner = (*OpenClawScanner)(nil)

func NewOpenClawScanner() *OpenClawScanner { return &OpenClawScanner{} }

func (s *OpenClawScanner) Platform() PlatformID { return PlatformOpenClaw }

func (s *OpenClawScanner) Scan(roots []string) ([]Item, error) {
	var items []Item
	for _, root := range roots {
		if _, err := os.Stat(root); os.IsNotExist(err) {
			continue
		}
		err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			if !strings.HasSuffix(path, ".trajectory.jsonl") {
				return nil
			}
			info, err := d.Info()
			if err != nil || info == nil {
				return nil // skip unreadable entry
			}
			item := Item{
				Platform:  PlatformOpenClaw,
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

func (s *OpenClawScanner) Read(item Item) (*Conversation, error) {
	f, err := os.Open(item.Path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	conv := &Conversation{Item: item}
	scanner := bufio.NewScanner(f)
	buf := make([]byte, 0, 1024*1024)
	scanner.Buffer(buf, 64*1024*1024)
	lineNum := 0

	const maxRunes = 8000

	// We use the last model.completed snapshot as the canonical conversation.
	// All prior snapshots are intermediate states (OpenClaw appends full snapshots
	// after each turn, so the last one is the most complete).
	var lastSnapshot []any
	var sessionID string

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

		if sessionID == "" {
			if sid := stringFieldCC(ev, "sessionId"); sid != "" {
				sessionID = sid
			}
		}

		evType := stringFieldCC(ev, "type")
		if evType != "model.completed" {
			continue
		}

		data := objectMapCC(ev["data"])
		if data == nil {
			continue
		}
		if snap, ok := data["messagesSnapshot"].([]any); ok && len(snap) > 0 {
			lastSnapshot = snap
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	if lastSnapshot == nil {
		conv.Warnings = append(conv.Warnings, "no model.completed snapshot found")
		conv.ID = ConversationID(PlatformOpenClaw, sessionID, item.Path)
		return conv, nil
	}

	// Parse the snapshot into messages.
	// Use file mtime as deterministic fallback base — never time.Now() (breaks idempotency).
	var fallbackBase int64
	if fi, err := os.Stat(item.Path); err == nil {
		fallbackBase = fi.ModTime().UnixMilli()
	} else {
		fallbackBase = time.Unix(0, 0).UnixMilli()
	}
	for i, raw := range lastSnapshot {
		m := objectMapCC(raw)
		if m == nil {
			conv.Warnings = append(conv.Warnings, fmt.Sprintf("snapshot[%d]: not an object, skipped", i))
			continue
		}
		role := stringFieldCC(m, "role")
		// OpenClaw uses "toolResult" (camelCase) for tool results
		ts := normalizeTimestampCC(m["timestamp"], fallbackBase+int64(i))

		switch role {
		case "user":
			text := openClawContentText(m["content"], maxRunes)
			if text == "" {
				conv.Warnings = append(conv.Warnings, fmt.Sprintf("snapshot[%d]: user message with no text, skipped", i))
				continue
			}
			conv.Messages = append(conv.Messages, AgentMemoryMessage{
				Role:      "user",
				Timestamp: ts,
				Content:   Redact(text),
			})
		case "assistant":
			msg := openClawAssistantMessage(m, ts, maxRunes, i)
			if msg == nil {
				conv.Warnings = append(conv.Warnings, fmt.Sprintf("snapshot[%d]: assistant message with no content, skipped", i))
				continue
			}
			conv.Messages = append(conv.Messages, *msg)
		case "toolResult":
			toolCallID := firstNonEmptyCC(stringFieldCC(m, "toolCallId"), stringFieldCC(m, "tool_call_id"))
			if toolCallID == "" {
				conv.Warnings = append(conv.Warnings, fmt.Sprintf("snapshot[%d]: toolResult missing toolCallId, dropped", i))
				continue
			}
			text := openClawContentText(m["content"], maxRunes)
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
				conv.Warnings = append(conv.Warnings, fmt.Sprintf("snapshot[%d]: unknown role %q, skipped", i, role))
			}
		}
	}

	setStartedAtFromMessages(conv)
	conv.ID = ConversationID(PlatformOpenClaw, sessionID, item.Path)
	return conv, nil
}

func openClawAssistantMessage(m map[string]any, ts int64, maxRunes, idx int) *AgentMemoryMessage {
	content, ok := m["content"].([]any)
	if !ok {
		return nil
	}
	var textParts []string
	var calls []AgentMemoryToolCall
	for j, raw := range content {
		b := objectMapCC(raw)
		if b == nil {
			continue
		}
		switch stringFieldCC(b, "type") {
		case "text":
			if text := stringFieldCC(b, "text"); text != "" {
				textParts = append(textParts, truncateRunesCC(text, maxRunes))
			}
		case "toolCall":
			id := firstNonEmptyCC(stringFieldCC(b, "id"), fmt.Sprintf("oc_tool_%d_%d_%d", ts, idx, j))
			calls = append(calls, AgentMemoryToolCall{
				ID:        id,
				Type:      "function",
				Name:      firstNonEmptyCC(stringFieldCC(b, "name"), "unknown"),
				Arguments: Redact(argumentsStringCC(b["arguments"])),
			})
		}
	}
	msg := AgentMemoryMessage{Role: "assistant", Timestamp: ts}
	if text := strings.TrimSpace(strings.Join(textParts, "\n\n")); text != "" {
		msg.Content = Redact(text)
	}
	if len(calls) > 0 {
		msg.ToolCalls = calls
	}
	if msg.Content == nil && len(msg.ToolCalls) == 0 {
		return nil
	}
	return &msg
}

func openClawContentText(v any, maxRunes int) string {
	switch x := v.(type) {
	case string:
		return truncateRunesCC(strings.TrimSpace(x), maxRunes)
	case []any:
		parts := make([]string, 0, len(x))
		for _, item := range x {
			if s, ok := item.(string); ok {
				parts = append(parts, s)
				continue
			}
			b := objectMapCC(item)
			if b == nil {
				continue
			}
			if text := stringFieldCC(b, "text"); text != "" {
				parts = append(parts, text)
			}
		}
		return truncateRunesCC(strings.TrimSpace(strings.Join(parts, "\n")), maxRunes)
	default:
		return ""
	}
}
