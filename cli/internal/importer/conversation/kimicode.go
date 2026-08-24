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

// KimicodeScanner parses Kimi Code (~/.kimi-code) wire.jsonl session
// transcripts. Each session's main-agent transcript lives at
// sessions/<workDirKey>/session_<uuid>/agents/main/wire.jsonl and is an
// append-only JSON-Lines event stream (timestamps in epoch ms under "time").
//
// Event mapping (confirmed from real local sessions):
//   - context.append_message, message.role=user, origin.kind != "injection"
//     -> user message (turn.prompt is ignored; it duplicates this).
//   - context.append_loop_event, event.type=content.part, part.type=="text"
//     -> assistant text, aggregated per turnId/step, flushed at step.end.
//     "think" parts are dropped.
//   - message.toolCalls (when non-empty) -> assistant tool calls. The on-disk
//     tool serialization was not observed in any local session, so this path
//     is defensive (see kimicodeToolCalls) and warns on unrecognized shapes.
type KimicodeScanner struct{}

var _ Scanner = (*KimicodeScanner)(nil)

func NewKimicodeScanner() *KimicodeScanner { return &KimicodeScanner{} }

func (s *KimicodeScanner) Platform() PlatformID { return PlatformKimicode }

func (s *KimicodeScanner) Scan(roots []string) ([]Item, error) {
	var items []Item
	for _, root := range roots {
		if _, err := os.Stat(root); os.IsNotExist(err) {
			continue
		}
		err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			// Every agent transcript under a session: agents/<agentId>/wire.jsonl
			// — the main agent AND each subagent. A session that delegates work
			// keeps that tool activity in the subagents' own wire.jsonl, so we
			// import them too; each becomes its own conversation, distinguished
			// by OriginID (main -> session_<uuid>, subagent -> session_<uuid>__<subid>).
			if filepath.Base(path) != "wire.jsonl" {
				return nil
			}
			if filepath.Base(filepath.Dir(filepath.Dir(path))) != "agents" {
				return nil
			}
			info, err := d.Info()
			if err != nil || info == nil {
				return nil
			}
			items = append(items, Item{
				Platform:  PlatformKimicode,
				Path:      path,
				OriginID:  kimicodeSessionID(path),
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

// kimicodeSessionID derives a stable per-transcript origin id from a
// .../session_<uuid>/agents/<agentId>/wire.jsonl path. The main agent maps to
// "session_<uuid>"; a subagent maps to "session_<uuid>__<agentId>" so its
// ConversationID does not collide with the main session's. Returns "" when the
// layout doesn't match (ConversationID then falls back to a path hash).
func kimicodeSessionID(path string) string {
	agentID := filepath.Base(filepath.Dir(path)) // "main" or "<subid>"
	sessionDir := filepath.Dir(filepath.Dir(filepath.Dir(path)))
	base := filepath.Base(sessionDir)
	if !strings.HasPrefix(base, "session_") {
		return ""
	}
	if agentID == "" || agentID == "main" {
		return base
	}
	return base + "__" + agentID
}

func (s *KimicodeScanner) Read(item Item) (*Conversation, error) {
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

	// assistant text aggregator keyed by turnId+step
	type aggKey struct {
		turn string
		step float64
	}
	pending := map[aggKey]*strings.Builder{}
	pendingTS := map[aggKey]int64{}
	flush := func(k aggKey) {
		b := pending[k]
		if b == nil {
			return
		}
		text := truncateRunesCC(strings.TrimSpace(b.String()), maxRunes)
		if text != "" {
			conv.Messages = append(conv.Messages, AgentMemoryMessage{
				Role:      "assistant",
				Timestamp: pendingTS[k],
				Content:   Redact(text),
			})
		}
		delete(pending, k)
		delete(pendingTS, k)
	}

	lineNum := 0
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
		ts := normalizeTimestampCC(ev["time"], fallbackBase+int64(lineNum))

		switch stringFieldCC(ev, "type") {
		case "context.append_message":
			msg := objectMapCC(ev["message"])
			if msg == nil {
				continue
			}
			// Only genuine user input is captured here; assistant text + tool
			// calls/results arrive via context.append_loop_event. Keep role=user
			// with origin.kind=="user" (or no origin); drop every system-injected
			// pseudo-user message: injection (permission notices), skill_activation
			// (injected skill text), and any other non-user origin.
			if stringFieldCC(msg, "role") != "user" {
				continue
			}
			if origin := objectMapCC(msg["origin"]); origin != nil {
				if kind := stringFieldCC(origin, "kind"); kind != "" && kind != "user" {
					continue
				}
			}
			text := kimicodeTextFromContent(msg["content"], maxRunes)
			if text == "" {
				continue
			}
			conv.Messages = append(conv.Messages, AgentMemoryMessage{
				Role:      "user",
				Timestamp: ts,
				Content:   Redact(text),
			})

		case "context.append_loop_event":
			event := objectMapCC(ev["event"])
			if event == nil {
				continue
			}
			k := aggKey{turn: stringFieldCC(event, "turnId")}
			if st, ok := event["step"].(float64); ok {
				k.step = st
			}
			switch stringFieldCC(event, "type") {
			case "content.part":
				part := objectMapCC(event["part"])
				if part == nil || stringFieldCC(part, "type") != "text" {
					continue // drop "think" and non-text parts
				}
				if pending[k] == nil {
					pending[k] = &strings.Builder{}
					pendingTS[k] = ts
				}
				pending[k].WriteString(stringFieldCC(part, "text"))
			case "tool.call":
				// Flush any assistant preamble text for this step first so order
				// is text -> tool call -> tool result.
				flush(k)
				name := stringFieldCC(event, "name")
				if name == "" {
					conv.Warnings = append(conv.Warnings, fmt.Sprintf("line %d: tool.call missing name, skipped", lineNum))
					continue
				}
				id := firstNonEmptyCC(stringFieldCC(event, "toolCallId"), stringFieldCC(event, "uuid"), fmt.Sprintf("kimicode_tool_%d", lineNum))
				conv.Messages = append(conv.Messages, AgentMemoryMessage{
					Role:      "assistant",
					Timestamp: ts,
					ToolCalls: []AgentMemoryToolCall{{
						ID:        id,
						Type:      "function",
						Name:      name,
						Arguments: Redact(argumentsStringCC(event["args"])),
					}},
				})
			case "tool.result":
				id := firstNonEmptyCC(stringFieldCC(event, "toolCallId"), stringFieldCC(event, "parentUuid"))
				if id == "" {
					conv.Warnings = append(conv.Warnings, fmt.Sprintf("line %d: tool.result missing toolCallId, skipped", lineNum))
					continue
				}
				out := ""
				if r := objectMapCC(event["result"]); r != nil {
					out = stringFieldCC(r, "output")
				}
				out = truncateRunesCC(strings.TrimSpace(out), maxRunes)
				if out == "" {
					out = "tool result"
				}
				conv.Messages = append(conv.Messages, AgentMemoryMessage{
					Role:       "tool",
					Timestamp:  ts,
					ToolCallID: id,
					Content:    Redact(out),
				})
			case "step.end":
				flush(k)
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	// Flush any steps that never emitted an explicit step.end.
	for k := range pending {
		flush(k)
	}

	setStartedAtFromMessages(conv)
	conv.ID = ConversationID(PlatformKimicode, item.OriginID, item.Path)
	return conv, nil
}

// kimicodeTextFromContent joins text blocks from a message.content array
// ([]{type:"text", text:"..."}), or returns a plain string as-is.
func kimicodeTextFromContent(content any, maxRunes int) string {
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
