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

// ravenPluginID is the Raven plugin id under which the installer writes
// the EverMe per-agent config (plugins.config["everme-memory"]).
// keep in sync with cli/internal/plugin/raven.go RavenPluginID
const ravenPluginID = "everme-memory"

// RavenScanner parses Raven (~/.raven/workspace/sessions) session
// transcripts. Each session lives at sessions/<channel>/<chat_id>.jsonl
// (chat_id = "YYYYMMDD_HHMMSS_xxxxxx", sortable) and is an append-only
// JSON-Lines stream written by raven/session/manager.py:
//
//   - metadata records ({"_type": "metadata", ...}) are re-appended on
//     every save — skipped here (multiple occurrences per file).
//   - message records are the AgentLoop's OpenAI-style dicts serialized
//     verbatim: {"role", "content", "timestamp", ...} with assistant
//     messages carrying "tool_calls" ([{id, type, function: {name,
//     arguments}}]) and tool results carrying "tool_call_id".
//   - "timestamp" is datetime.now().isoformat() — a NAIVE local-time
//     ISO string without offset, so RFC3339 parsing fails on it; see
//     normalizeTimestampRaven.
type RavenScanner struct{}

var _ Scanner = (*RavenScanner)(nil)

func NewRavenScanner() *RavenScanner { return &RavenScanner{} }

func (s *RavenScanner) Platform() PlatformID { return PlatformRaven }

func (s *RavenScanner) Scan(roots []string) ([]Item, error) {
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
				return nil
			}
			items = append(items, Item{
				Platform:  PlatformRaven,
				Path:      path,
				OriginID:  ravenSessionID(path),
				Status:    "ready",
				SizeBytes: info.Size(),
				UpdatedAt: info.ModTime().UTC().Format(time.RFC3339),
			})
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return items, nil
}

// ravenSessionID derives the session key ("<channel>:<chat_id>") from a
// .../sessions/<channel>/<chat_id>.jsonl path — the same key Raven uses
// internally (session.key), so re-imports of a renamed/moved workspace
// stay idempotent. Returns "" when the layout doesn't match
// (ConversationID then falls back to a path hash).
func ravenSessionID(path string) string {
	chatID := strings.TrimSuffix(filepath.Base(path), ".jsonl")
	channel := filepath.Base(filepath.Dir(path))
	if chatID == "" || channel == "" || channel == "." || channel == string(filepath.Separator) {
		return ""
	}
	return channel + ":" + chatID
}

func (s *RavenScanner) Read(item Item) (*Conversation, error) {
	f, err := os.Open(item.Path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	conv := &Conversation{Item: item}
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 1024*1024), 64*1024*1024)

	// Deterministic fallback base — never time.Now() (breaks idempotency).
	var fallbackBase int64
	if fi, err := os.Stat(item.Path); err == nil {
		fallbackBase = fi.ModTime().UnixMilli()
	} else {
		fallbackBase = time.Unix(0, 0).UnixMilli()
	}

	const maxRunes = 8000

	lineNum := 0
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		lineNum++
		var rec map[string]any
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			conv.Warnings = append(conv.Warnings, fmt.Sprintf("line %d: json decode error: %v", lineNum, err))
			continue
		}
		if stringFieldCC(rec, "_type") == "metadata" {
			continue // re-appended on every save; not a message
		}
		ts := normalizeTimestampRaven(rec["timestamp"], fallbackBase+int64(lineNum))

		switch stringFieldCC(rec, "role") {
		case "user":
			text := ravenTextFromContent(rec["content"], maxRunes)
			if text == "" {
				continue
			}
			conv.Messages = append(conv.Messages, AgentMemoryMessage{
				Role:      "user",
				Timestamp: ts,
				Content:   Redact(text),
			})

		case "assistant":
			text := ravenTextFromContent(rec["content"], maxRunes)
			toolCalls := ravenToolCalls(rec["tool_calls"], lineNum, conv)
			if text == "" && len(toolCalls) == 0 {
				continue
			}
			msg := AgentMemoryMessage{
				Role:      "assistant",
				Timestamp: ts,
				ToolCalls: toolCalls,
			}
			if text != "" {
				msg.Content = Redact(text)
			}
			conv.Messages = append(conv.Messages, msg)

		case "tool":
			id := firstNonEmptyCC(stringFieldCC(rec, "tool_call_id"), stringFieldCC(rec, "toolCallId"))
			if id == "" {
				conv.Warnings = append(conv.Warnings, fmt.Sprintf("line %d: tool message missing tool_call_id, skipped", lineNum))
				continue
			}
			out := truncateRunesCC(strings.TrimSpace(ravenTextFromContent(rec["content"], maxRunes)), maxRunes)
			if out == "" {
				out = "tool result"
			}
			conv.Messages = append(conv.Messages, AgentMemoryMessage{
				Role:       "tool",
				Timestamp:  ts,
				ToolCallID: id,
				Content:    Redact(out),
			})

		default:
			// "system" (and anything unknown) is dropped: the BFF accepts
			// user/assistant/tool only.
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	setStartedAtFromMessages(conv)
	conv.ID = ConversationID(PlatformRaven, item.OriginID, item.Path)
	return conv, nil
}

// ravenToolCalls converts an OpenAI-style tool_calls array
// ([{id, type, function: {name, arguments}}]; arguments is a JSON
// string, but objects are tolerated) into the BFF DTO shape. Flat
// {id, name, arguments} entries without a "function" wrapper are
// tolerated too. Malformed entries warn and are skipped.
func ravenToolCalls(v any, lineNum int, conv *Conversation) []AgentMemoryToolCall {
	arr, _ := v.([]any)
	if len(arr) == 0 {
		return nil
	}
	out := make([]AgentMemoryToolCall, 0, len(arr))
	for _, raw := range arr {
		tc := objectMapCC(raw)
		if tc == nil {
			conv.Warnings = append(conv.Warnings, fmt.Sprintf("line %d: non-object tool_call entry, skipped", lineNum))
			continue
		}
		fn := objectMapCC(tc["function"])
		if fn == nil {
			fn = tc // flat shape fallback
		}
		name := stringFieldCC(fn, "name")
		if name == "" {
			conv.Warnings = append(conv.Warnings, fmt.Sprintf("line %d: tool_call missing function.name, skipped", lineNum))
			continue
		}
		out = append(out, AgentMemoryToolCall{
			ID:        firstNonEmptyCC(stringFieldCC(tc, "id"), fmt.Sprintf("raven_tool_%d", lineNum)),
			Type:      "function",
			Name:      name,
			Arguments: Redact(argumentsStringCC(fn["arguments"])),
		})
	}
	return out
}

// ravenTextFromContent joins text blocks from a message.content that is
// either a plain string or a multimodal parts array
// ([]{type:"text", text:"..."}); non-text parts are dropped.
func ravenTextFromContent(content any, maxRunes int) string {
	switch x := content.(type) {
	case string:
		return truncateRunesCC(strings.TrimSpace(x), maxRunes)
	case []any:
		parts := make([]string, 0, len(x))
		for _, raw := range x {
			b := objectMapCC(raw)
			if b == nil {
				continue
			}
			if stringFieldCC(b, "type") == "text" {
				if t := stringFieldCC(b, "text"); t != "" {
					parts = append(parts, t)
				}
			}
		}
		return truncateRunesCC(strings.TrimSpace(strings.Join(parts, "\n")), maxRunes)
	default:
		return ""
	}
}

// normalizeTimestampRaven handles Raven's naive local-time ISO strings
// (datetime.now().isoformat() — no offset, so RFC3339 parsing fails),
// then defers to normalizeTimestampCC for offset-carrying strings and
// epoch numbers. Naive timestamps are interpreted in the machine's
// local zone — the same zone that wrote them.
func normalizeTimestampRaven(v any, fallback int64) int64 {
	if s, ok := v.(string); ok {
		if t, err := time.ParseInLocation("2006-01-02T15:04:05.999999999", s, time.Local); err == nil {
			return t.UnixMilli()
		}
	}
	return normalizeTimestampCC(v, fallback)
}
