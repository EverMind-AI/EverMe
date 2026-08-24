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

// CodexScanner parses Codex JSONL session files.
// Each line is a JSON object with fields: type, timestamp, payload.
//
// type=response_item carries the conversation: payload.type =
// message | function_call | function_call_output | custom_tool_call |
// custom_tool_call_output | web_search_call are imported, reasoning is
// dropped, anything else warns.
// type=event_msg is the UI event stream — see codexKnownEventMsgTypes.
// type=session_meta and type=turn_context are skipped.
type CodexScanner struct{}

// codexKnownEventMsgTypes are the event_msg payload types we have seen on
// real rollouts and deliberately drop. They are either display-only
// (agent_message, task_started) or a second rendering of a response_item
// we already import: on a 44-session home, 97.3% of mcp_tool_call_end
// call ids also appeared as a response_item function_call, so importing
// them too would double-write the same tool round-trip.
var codexKnownEventMsgTypes = map[string]bool{
	"agent_message":           true,
	"agent_reasoning":         true,
	"context_compacted":       true,
	"mcp_tool_call_begin":     true,
	"mcp_tool_call_end":       true,
	"patch_apply_begin":       true,
	"patch_apply_end":         true,
	"reasoning":               true,
	"task_complete":           true,
	"task_started":            true,
	"thread_goal_updated":     true,
	"thread_rolled_back":      true,
	"thread_settings_applied": true,
	"token_count":             true,
	"turn_aborted":            true,
	"user_message":            true,
	"web_search_begin":        true,
	"web_search_end":          true,
}

var _ Scanner = (*CodexScanner)(nil)

func NewCodexScanner() *CodexScanner { return &CodexScanner{} }

func (s *CodexScanner) Platform() PlatformID { return PlatformCodex }

func (s *CodexScanner) Scan(roots []string) ([]Item, error) {
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
			// OpenClaw trajectory files also end in .jsonl; they belong to the
			// OpenClaw scanner and must never be parsed as Codex sessions.
			if strings.HasSuffix(path, ".trajectory.jsonl") {
				return nil
			}
			info, err := d.Info()
			if err != nil || info == nil {
				return nil // skip unreadable entry
			}
			item := Item{
				Platform:  PlatformCodex,
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

func (s *CodexScanner) Read(item Item) (*Conversation, error) {
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

		ts := normalizeTimestampCC(ev["timestamp"], fallbackBase+int64(lineNum))
		topType := stringFieldCC(ev, "type")
		payload := objectMapCC(ev["payload"])

		// Skip meta/context events
		if topType == "session_meta" || topType == "turn_context" {
			continue
		}

		// event_msg is Codex's UI event stream. Every type we know about
		// either duplicates a response_item or is pure display, so none of
		// them produce messages — but an unrecognised one is schema drift
		// we want to hear about rather than discard in silence.
		if topType == "event_msg" {
			if payload != nil {
				if pt := stringFieldCC(payload, "type"); pt != "" && !codexKnownEventMsgTypes[pt] {
					conv.Warnings = append(conv.Warnings, fmt.Sprintf("line %d: unknown event_msg payload type %q, skipped", lineNum, pt))
				}
			}
			continue
		}

		if topType != "response_item" || payload == nil {
			continue
		}

		switch stringFieldCC(payload, "type") {
		case "message":
			m, ok := codexMessageFromPayload(payload, ts, maxRunes)
			if !ok {
				continue
			}
			conv.Messages = append(conv.Messages, m)
		case "function_call":
			m := codexToolCallFromPayload(payload, ts)
			conv.Messages = append(conv.Messages, m)
		case "custom_tool_call":
			// Codex's sandboxed `exec` tool. Same call_id pairing as
			// function_call; the arguments arrive as a plain `input` string.
			conv.Messages = append(conv.Messages, codexCustomToolCallFromPayload(payload, ts))
		case "function_call_output", "custom_tool_call_output":
			callID := stringFieldCC(payload, "call_id")
			if callID == "" {
				conv.Warnings = append(conv.Warnings, fmt.Sprintf("line %d: %s missing call_id, dropped", lineNum, stringFieldCC(payload, "type")))
				continue
			}
			// function_call_output carries a plain string; custom_tool_call_output
			// carries the same typed content blocks a message does.
			text := truncateRunesCC(strings.TrimSpace(stringFieldCC(payload, "output")), maxRunes)
			if text == "" {
				text = codexTextFromContent(payload["output"], maxRunes)
			}
			if text == "" {
				text = "tool result"
			}
			conv.Messages = append(conv.Messages, AgentMemoryMessage{
				Role:       "tool",
				Timestamp:  ts,
				ToolCallID: callID,
				Content:    Redact(text),
			})
		case "web_search_call":
			// Self-contained: Codex records the search action but no
			// call_id and no paired output, so this is a tool call with a
			// deterministic synthetic id and no tool result to match.
			conv.Messages = append(conv.Messages, codexWebSearchFromPayload(payload, ts, lineNum))
		case "reasoning":
			// skip
		default:
			pt := stringFieldCC(payload, "type")
			if pt != "" {
				conv.Warnings = append(conv.Warnings, fmt.Sprintf("line %d: unknown response_item payload type %q, skipped", lineNum, pt))
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	setStartedAtFromMessages(conv)
	conv.ID = ConversationID(PlatformCodex, "", item.Path)
	return conv, nil
}

func codexMessageFromPayload(payload map[string]any, ts int64, maxRunes int) (AgentMemoryMessage, bool) {
	role := stringFieldCC(payload, "role")
	// developer role maps to user for memory purposes; skip other roles
	switch role {
	case "user", "developer":
		role = "user"
	case "assistant":
		// ok
	default:
		return AgentMemoryMessage{}, false
	}
	text := codexTextFromContent(payload["content"], maxRunes)
	if text == "" {
		return AgentMemoryMessage{}, false
	}
	return AgentMemoryMessage{Role: role, Timestamp: ts, Content: Redact(text)}, true
}

func codexToolCallFromPayload(payload map[string]any, ts int64) AgentMemoryMessage {
	callID := firstNonEmptyCC(stringFieldCC(payload, "call_id"), fmt.Sprintf("codex_tool_%d", ts))
	return AgentMemoryMessage{
		Role:      "assistant",
		Timestamp: ts,
		ToolCalls: []AgentMemoryToolCall{{
			ID:        callID,
			Type:      "function",
			Name:      firstNonEmptyCC(stringFieldCC(payload, "name"), "unknown"),
			Arguments: Redact(argumentsStringCC(payload["arguments"])),
		}},
	}
}

func codexCustomToolCallFromPayload(payload map[string]any, ts int64) AgentMemoryMessage {
	callID := firstNonEmptyCC(stringFieldCC(payload, "call_id"), fmt.Sprintf("codex_custom_tool_%d", ts))
	return AgentMemoryMessage{
		Role:      "assistant",
		Timestamp: ts,
		ToolCalls: []AgentMemoryToolCall{{
			ID:        callID,
			Type:      "function",
			Name:      firstNonEmptyCC(stringFieldCC(payload, "name"), "unknown"),
			Arguments: Redact(argumentsStringCC(payload["input"])),
		}},
	}
}

func codexWebSearchFromPayload(payload map[string]any, ts int64, lineNum int) AgentMemoryMessage {
	return AgentMemoryMessage{
		Role:      "assistant",
		Timestamp: ts,
		ToolCalls: []AgentMemoryToolCall{{
			ID: fmt.Sprintf("codex_web_search_%d_%d", ts, lineNum),
			// The action object holds the query (or the page for
			// open_page / find_in_page), so keep it whole.
			Type:      "function",
			Name:      "web_search",
			Arguments: Redact(argumentsStringCC(payload["action"])),
		}},
	}
}

func codexTextFromContent(content any, maxRunes int) string {
	switch x := content.(type) {
	case string:
		return truncateRunesCC(strings.TrimSpace(x), maxRunes)
	case []any:
		parts := make([]string, 0, len(x))
		for _, raw := range x {
			if s, ok := raw.(string); ok {
				parts = append(parts, s)
				continue
			}
			b := objectMapCC(raw)
			if b == nil {
				continue
			}
			switch stringFieldCC(b, "type") {
			case "input_text", "output_text", "text":
				if text := stringFieldCC(b, "text"); text != "" {
					parts = append(parts, text)
				}
			}
		}
		return truncateRunesCC(strings.TrimSpace(strings.Join(parts, "\n")), maxRunes)
	default:
		return ""
	}
}
