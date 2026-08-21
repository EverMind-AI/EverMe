package conversation

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// WorkBuddyScanner parses WorkBuddy JSONL session files.
//
// Each line is a flat JSON object with a top-level "type" field:
//
//	message                -> role user|assistant turn (content is []{type,text})
//	function_call          -> assistant tool call; arguments is a JSON-encoded
//	                           string (re-marshalled through argumentsStringCC)
//	function_call_result   -> role=tool message, paired to function_call by
//	                           the shared "callId" field (not call_id)
//	reasoning               -> internal chain-of-thought, skipped
//	file-history-snapshot   -> editor undo checkpoint, skipped
//	ai-title                -> auto-generated session title, skipped (no
//	                           Item/Conversation field to hold it yet)
//
// See docs/spec/workbuddy-cold-start-import.md for the full contract this
// mirrors, including why the three text-cleaning rules below exist.
type WorkBuddyScanner struct{}

var _ Scanner = (*WorkBuddyScanner)(nil)

func NewWorkBuddyScanner() *WorkBuddyScanner { return &WorkBuddyScanner{} }

func (s *WorkBuddyScanner) Platform() PlatformID { return PlatformWorkBuddy }

func (s *WorkBuddyScanner) Scan(roots []string) ([]Item, error) {
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
			items = append(items, Item{
				Platform:  PlatformWorkBuddy,
				Path:      path,
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

func (s *WorkBuddyScanner) Read(item Item) (*Conversation, error) {
	f, err := os.Open(item.Path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	conv := &Conversation{Item: item}
	scanner := bufio.NewScanner(f)
	buf := make([]byte, 0, 1024*1024)
	// A single tool-result line has been observed over 64KB (the default
	// bufio.Scanner cap), so this must be raised - see spec §2.4.
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

		// Every record type carries sessionId; grab it from whichever line
		// has it first (file-history-snapshot lines do not).
		if originID == "" {
			if sid, ok := ev["sessionId"].(string); ok && sid != "" {
				originID = sid
			}
		}

		ts := normalizeTimestampCC(ev["timestamp"], fallbackBase+int64(lineNum))
		recType := stringFieldCC(ev, "type")

		switch recType {
		case "reasoning", "file-history-snapshot", "ai-title":
			// Not conversational content - see package doc comment.
			continue

		case "message":
			if isWorkBuddyInternalMessage(ev) {
				continue
			}
			m, ok := workBuddyMessageFromRecord(ev, ts, maxRunes)
			if !ok {
				continue
			}
			conv.Messages = append(conv.Messages, m)

		case "function_call":
			callID := firstNonEmptyCC(stringFieldCC(ev, "callId"), fmt.Sprintf("workbuddy_tool_%d", ts))
			conv.Messages = append(conv.Messages, AgentMemoryMessage{
				Role:      "assistant",
				Timestamp: ts,
				ToolCalls: []AgentMemoryToolCall{{
					ID:        callID,
					Type:      "function",
					Name:      firstNonEmptyCC(stringFieldCC(ev, "name"), "unknown"),
					Arguments: Redact(argumentsStringCC(ev["arguments"])),
				}},
			})

		case "function_call_result":
			callID := stringFieldCC(ev, "callId")
			if callID == "" {
				conv.Warnings = append(conv.Warnings, fmt.Sprintf("line %d: function_call_result missing callId, dropped", lineNum))
				continue
			}
			text := truncateRunesCC(strings.TrimSpace(workBuddyOutputText(ev["output"])), maxRunes)
			if text == "" {
				text = "tool result"
			}
			conv.Messages = append(conv.Messages, AgentMemoryMessage{
				Role:       "tool",
				Timestamp:  ts,
				ToolCallID: callID,
				Content:    Redact(text),
			})

		default:
			if recType != "" {
				conv.Warnings = append(conv.Warnings, fmt.Sprintf("line %d: unknown record type %q, skipped", lineNum, recType))
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	setStartedAtFromMessages(conv)
	conv.ID = ConversationID(PlatformWorkBuddy, originID, item.Path)
	return conv, nil
}

var (
	// <user_query> is the real text a user typed. It is NOT unique to the
	// first message or to a <cb_summary> compaction wrapper: a real upload
	// against this machine's own WorkBuddy history showed EVERY user turn
	// wrapped in <system-reminder data-role="user-context"> with
	// <user_info>/<identity_context>/<additional_data>/
	// <memory_and_skills_reminder> injected ahead of a trailing
	// <user_query>...</user_query> that holds what the user actually typed.
	// The original assumption (system-reminder = first-message-only
	// boilerplate, safe to drop whole) was wrong and silently discarded the
	// user's real question on every turn - see docs/spec/workbuddy-cold-start-import.md.
	// Extracting <user_query> unconditionally, whatever wraps it, is both
	// simpler and correct for the first message, an ordinary later turn, and
	// a <cb_summary> compaction turn alike.
	workBuddyUserQueryRe = regexp.MustCompile(`(?s)<user_query>(.*?)</user_query>`)
	// Fallback tag-stripping for the (so far unobserved, but plausible) case
	// of a wrapper with no <user_query> inside - remove the injected
	// boilerplate and keep whatever real text is left outside it, rather
	// than drop the whole message.
	workBuddySystemReminderRe = regexp.MustCompile(`(?s)<system-reminder[^>]*>.*?</system-reminder>`)
	workBuddyAdditionalDataRe = regexp.MustCompile(`(?s)<additional_data>.*?</additional_data>`)
	workBuddyWorkingMemoryRe  = regexp.MustCompile(`(?s)<working_memory_reminder>.*?</working_memory_reminder>`)
)

// workBuddyMessageFromRecord turns a "message" record into an
// AgentMemoryMessage, or ok=false when it carries no importable content
// (an empty body, or a wrapper with nothing real left after cleaning).
func workBuddyMessageFromRecord(ev map[string]any, ts int64, maxRunes int) (AgentMemoryMessage, bool) {
	role := stringFieldCC(ev, "role")
	switch role {
	case "user", "assistant":
	default:
		return AgentMemoryMessage{}, false
	}

	text := workBuddyRawTextFromContent(ev["content"])
	if text == "" {
		return AgentMemoryMessage{}, false
	}

	if role == "user" {
		text = workBuddyCleanUserText(text)
		if text == "" {
			return AgentMemoryMessage{}, false
		}
	}

	text = truncateRunesCC(text, maxRunes)
	return AgentMemoryMessage{Role: role, Timestamp: ts, Content: Redact(text)}, true
}

// workBuddyCleanUserText extracts the real content of a user message.
// <user_query> wins whenever present - regardless of what wraps it (the
// synthetic first-message context dump, an ordinary later turn's per-message
// reminder injection, or a <cb_summary> compaction wrapper all end in one).
// Only when no <user_query> is found does it fall back to stripping the
// known boilerplate tags and keeping whatever text is left outside them.
func workBuddyCleanUserText(text string) string {
	if m := workBuddyUserQueryRe.FindStringSubmatch(text); m != nil {
		return strings.TrimSpace(m[1])
	}
	text = workBuddySystemReminderRe.ReplaceAllString(text, "")
	text = workBuddyAdditionalDataRe.ReplaceAllString(text, "")
	text = workBuddyWorkingMemoryRe.ReplaceAllString(text, "")
	return strings.TrimSpace(text)
}

// workBuddyRawTextFromContent joins a message's content blocks
// ([{type:"input_text"|"output_text",text:"..."}]) into plain text.
// Deliberately NOT truncated here: truncateRunesCC keeps head+tail and drops
// the middle, and a real <user_query> inside a large <cb_summary> wrapper
// could sit anywhere - cleaning must run on the full text before any cap is
// applied (see workBuddyMessageFromRecord).
func workBuddyRawTextFromContent(content any) string {
	if s, ok := content.(string); ok {
		return strings.TrimSpace(s)
	}
	blocks, ok := content.([]any)
	if !ok {
		return ""
	}
	parts := make([]string, 0, len(blocks))
	for _, raw := range blocks {
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
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

// isWorkBuddyInternalMessage reports whether a "message" record is
// WorkBuddy-internal machinery (compaction bookkeeping, teammate relay)
// rather than a turn a user or the assistant actually exchanged - spec §3.3.
func isWorkBuddyInternalMessage(ev map[string]any) bool {
	pd := objectMapCC(ev["providerData"])
	if pd == nil {
		return false
	}
	if b, ok := pd["skipRun"].(bool); ok && b {
		return true
	}
	if b, ok := pd["isCompactInternal"].(bool); ok && b {
		return true
	}
	if s, ok := pd["agent"].(string); ok && s == "compact" {
		return true
	}
	if tm := objectMapCC(pd["teammateMessage"]); tm != nil {
		if from, ok := tm["from"].(string); ok && from != "" {
			return true
		}
	}
	return false
}

// workBuddyOutputText extracts a function_call_result's rendered text.
// {"type":"text","text":"..."} is the common shape; anything else (e.g. the
// "list" structured-output shape) is JSON-dumped rather than silently
// dropped, matching this package's warn-don't-fail convention.
func workBuddyOutputText(v any) string {
	m := objectMapCC(v)
	if m == nil {
		if s, ok := v.(string); ok {
			return s
		}
		return ""
	}
	if stringFieldCC(m, "type") == "text" {
		return stringFieldCC(m, "text")
	}
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(b)
}
