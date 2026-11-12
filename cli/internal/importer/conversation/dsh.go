package conversation

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/klauspost/compress/zstd"
)

// DSHScanner parses DeepSeek Harness (dsh) session logs.
//
// Layout: one log per session, grouped by workspace:
//
//	<DSH_HOME>/sessions/<escaped-workspace>/session-<uuid>/session.v4.jsonl.zstd
//
// The file is zstd-compressed JSONL: a `session` header line (version, id,
// createdAt, cwd) followed by event-sourced records of the shape
// {type, seq, time, data}. `time` is epoch milliseconds.
//
// Imported: user/message, assistant/message (its text plus the tool-call
// blocks it carries) and tool/result. The dedicated tool/call records
// duplicate the assistant message's own tool-call blocks one-for-one (206 of
// 206 call ids on a real session), so they are only used for a call that no
// assistant message carried — importing both would double-write every
// round-trip.
//
// Skipped: system/message (instructions and compaction context, not
// conversation), reasoning content blocks, and the bookkeeping event stream
// (step/turn boundaries, approvals, sandbox mode, jobs, todo writes, slash
// command output, delivery receipts). agent/inbox/spliced is skipped because
// it replays a user/message that is recorded separately under the same id.
type DSHScanner struct{}

// dshSupportedFormatVersion is the session header's `version` this reader
// understands. A newer version is imported on a best-effort basis and warns,
// so a future DSH release degrades to "some records skipped" instead of
// silently importing a partial session.
const dshSupportedFormatVersion = 4

// dshKnownSkippedEvents are event types that carry no conversation text.
// An unrecognised type still produces one warning per session, so schema
// drift is visible in scan output instead of disappearing.
var dshKnownSkippedEvents = map[string]bool{
	"agent/inbox/spliced":                    true, // duplicate delivery, see the type comment
	"approval/asked":                         true,
	"approval/decided":                       true,
	"approval/policy":                        true,
	"assistant/attempt":                      true, // per-attempt stream metadata; the message is its own record
	"command/done":                           true,
	"command/run":                            true,
	"compaction/end":                         true,
	"compaction/prune":                       true,
	"compaction/start":                       true,
	"compaction/summary":                     true, // context-management summary, not a user/agent turn
	"deliverables/presented":                 true,
	"job/registered":                         true,
	"job/settled":                            true,
	"llm/retry":                              true,
	"llm/retry-started":                      true,
	"model/selection":                        true,
	"permission/preset":                      true,
	"request/context":                        true,
	"request/header":                         true,
	"sandbox/mode":                           true,
	"session-log-deepseek/delivery-accepted": true,
	"session/end-seed":                       true,
	"session/title":                          true,
	"session/title-llm-request":              true,
	"step/end":                               true,
	"step/start":                             true,
	"subagent/catalog":                       true,
	"subagent/descriptor":                    true, // session header for the delegation preset
	"system/message":                         true,
	"todo/write":                             true,
	"turn/end":                               true,
	"turn/start":                             true,
	"web/deepseek-search-llm-request":        true, // request log for the search sub-model
	"working-directory/change":               true,
	"workspace/changes":                      true,
}

var _ Scanner = (*DSHScanner)(nil)

// NewDSHScanner returns the DeepSeek Harness scanner.
func NewDSHScanner() *DSHScanner { return &DSHScanner{} }

func (s *DSHScanner) Platform() PlatformID { return PlatformDSH }

func (s *DSHScanner) Scan(roots []string) ([]Item, error) {
	var items []Item
	for _, root := range roots {
		if _, err := os.Stat(root); os.IsNotExist(err) {
			continue
		}
		err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			if !isDSHSessionFile(path) {
				return nil
			}
			info, statErr := d.Info()
			if statErr != nil || info == nil {
				return nil // skip unreadable entry
			}
			items = append(items, Item{
				Platform:  PlatformDSH,
				Path:      path,
				OriginID:  dshOriginID(path),
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

func (s *DSHScanner) Read(item Item) (*Conversation, error) {
	f, err := os.Open(item.Path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var src io.Reader = f
	if strings.HasSuffix(item.Path, ".zstd") {
		zr, zerr := zstd.NewReader(f)
		if zerr != nil {
			return nil, fmt.Errorf("open zstd stream: %w", zerr)
		}
		defer zr.Close()
		src = zr
	}

	conv := &Conversation{Item: item}

	// Use the file mtime as the deterministic fallback timestamp — never
	// time.Now(), which would break re-import idempotency.
	fallbackBase := time.Unix(0, 0).UnixMilli()
	if fi, statErr := os.Stat(item.Path); statErr == nil {
		fallbackBase = fi.ModTime().UnixMilli()
	}

	sc := bufio.NewScanner(src)
	sc.Buffer(make([]byte, 0, 1024*1024), 64*1024*1024)

	const maxRunes = 8000

	lineNum := 0
	headerID := ""
	version := 0
	// attached tracks tool-call ids already imported with their assistant
	// message, so the tool/call record for the same id is not a second copy.
	attached := map[string]bool{}
	// warned keeps one warning per unknown type instead of one per record.
	warned := map[string]bool{}

	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		lineNum++

		var ev map[string]any
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			conv.Warnings = append(conv.Warnings, fmt.Sprintf("line %d: json decode error: %v", lineNum, err))
			continue
		}

		topType := stringFieldCC(ev, "type")
		ts := normalizeTimestampCC(ev["time"], fallbackBase+int64(lineNum))
		data := objectMapCC(ev["data"])

		if topType == "session" {
			headerID = firstNonEmptyCC(stringFieldCC(ev, "id"), headerID)
			if v, ok := ev["version"].(float64); ok {
				version = int(v)
			}
			if version > dshSupportedFormatVersion {
				conv.Warnings = append(conv.Warnings, fmt.Sprintf(
					"line %d: session format v%d is newer than the supported v%d; unknown records are skipped",
					lineNum, version, dshSupportedFormatVersion))
			}
			continue
		}

		switch topType {
		case "user/message":
			text := dshTextFromBlocks(data["content"], maxRunes, &conv.Warnings, warned, lineNum)
			if text == "" {
				continue
			}
			conv.Messages = append(conv.Messages, AgentMemoryMessage{
				Role:      "user",
				Timestamp: ts,
				Content:   Redact(text),
			})

		case "assistant/message":
			msg := objectMapCC(data["message"])
			content := msg["content"]
			text := dshTextFromBlocks(content, maxRunes, &conv.Warnings, warned, lineNum)
			calls := dshToolCallsFromBlocks(content)
			for _, c := range calls {
				attached[c.ID] = true
			}
			if text == "" && len(calls) == 0 {
				continue // reasoning-only step
			}
			out := AgentMemoryMessage{Role: "assistant", Timestamp: ts, ToolCalls: calls}
			if text != "" {
				out.Content = Redact(text)
			}
			conv.Messages = append(conv.Messages, out)

		case "tool/call":
			// Normally already imported with the assistant message that
			// emitted it; keep this path for a call that message did not carry.
			callID := stringFieldCC(data, "callId")
			if callID == "" {
				if !warned["tool/call"] {
					warned["tool/call"] = true
					conv.Warnings = append(conv.Warnings, fmt.Sprintf("line %d: tool/call without callId, dropped", lineNum))
				}
				continue
			}
			if attached[callID] {
				continue
			}
			attached[callID] = true
			conv.Messages = append(conv.Messages, AgentMemoryMessage{
				Role:      "assistant",
				Timestamp: ts,
				ToolCalls: []AgentMemoryToolCall{{
					ID:        callID,
					Type:      "function",
					Name:      firstNonEmptyCC(stringFieldCC(data, "name"), "unknown"),
					Arguments: Redact(argumentsStringCC(data["arguments"])),
				}},
			})

		case "tool/result":
			msg := objectMapCC(data["message"])
			callID := firstNonEmptyCC(stringFieldCC(msg, "toolCallId"), stringFieldCC(data, "toolCallId"))
			if callID == "" {
				if !warned["tool/result"] {
					warned["tool/result"] = true
					conv.Warnings = append(conv.Warnings, fmt.Sprintf("line %d: tool/result without toolCallId, dropped", lineNum))
				}
				continue
			}
			text := dshTextFromBlocks(msg["content"], maxRunes, &conv.Warnings, warned, lineNum)
			if text == "" {
				text = "tool result"
			}
			if isErr, _ := msg["isError"].(bool); isErr {
				text = "[error] " + text
			}
			conv.Messages = append(conv.Messages, AgentMemoryMessage{
				Role:       "tool",
				Timestamp:  ts,
				ToolCallID: callID,
				Content:    Redact(text),
			})

		default:
			if topType != "" && !dshKnownSkippedEvents[topType] && !warned[topType] {
				warned[topType] = true
				conv.Warnings = append(conv.Warnings, fmt.Sprintf("line %d: unknown event type %q, skipped", lineNum, topType))
			}
		}
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("read session stream: %w", err)
	}

	setStartedAtFromMessages(conv)
	conv.ID = ConversationID(PlatformDSH, firstNonEmptyCC(headerID, item.OriginID), item.Path)
	return conv, nil
}

// isDSHSessionFile reports whether path is one of DSH's session logs. The
// basename carries the format version ("session.v4.jsonl.zstd"), and older
// uncompressed logs ("session.v3.jsonl") are accepted too.
func isDSHSessionFile(path string) bool {
	base := filepath.Base(path)
	if !strings.HasPrefix(base, "session.") {
		return false
	}
	return strings.HasSuffix(base, ".jsonl") || strings.HasSuffix(base, ".jsonl.zstd")
}

// dshOriginID returns the session id from the directory layout so scan output
// and the conversation id survive a file rename. Current DSH versions name the
// directory "<uuid>"; older layouts used "session-<uuid>", which is the same id
// the session header carries. Empty when the log lives elsewhere - Read then
// falls back to the header id or the path.
func dshOriginID(path string) string {
	dir := filepath.Base(filepath.Dir(path))
	if strings.HasPrefix(dir, "session-") {
		return dir
	}
	if isUUID(dir) {
		return "session-" + dir
	}
	return ""
}

// isUUID matches the 8-4-4-4-12 hex shape a session directory uses.
func isUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, r := range s {
		switch i {
		case 8, 13, 18, 23:
			if r != '-' {
				return false
			}
		default:
			isHex := (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')
			if !isHex {
				return false
			}
		}
	}
	return true
}

// dshTextFromBlocks joins the text blocks of a DSH content array. Reasoning
// and tool-call blocks are handled elsewhere and pass silently; any other
// block type (image, document, ...) warns once per type and is dropped.
func dshTextFromBlocks(content any, maxRunes int, warnings *[]string, warned map[string]bool, lineNum int) string {
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
			block := objectMapCC(raw)
			if block == nil {
				continue
			}
			blockType := stringFieldCC(block, "type")
			switch blockType {
			case "text":
				if text := stringFieldCC(block, "text"); text != "" {
					parts = append(parts, text)
				}
			case "reasoning", "tool-call":
				// Reasoning is model-internal; tool calls are imported as
				// structured ToolCalls, not as text.
			case "image":
				// Pasted images are not uploaded; the surrounding text still
				// carries the question. Silent, like the other importers.
			default:
				if blockType != "" && !warned["block:"+blockType] {
					warned["block:"+blockType] = true
					*warnings = append(*warnings, fmt.Sprintf("line %d: unsupported content block type %q, skipped", lineNum, blockType))
				}
			}
		}
		return truncateRunesCC(strings.TrimSpace(strings.Join(parts, "\n")), maxRunes)
	default:
		return ""
	}
}

// dshToolCallsFromBlocks extracts the assistant message's tool-call blocks.
// Each block mirrors the standalone tool/call record: {id, name, arguments}.
func dshToolCallsFromBlocks(content any) []AgentMemoryToolCall {
	blocks, ok := content.([]any)
	if !ok {
		return nil
	}
	var calls []AgentMemoryToolCall
	for _, raw := range blocks {
		block := objectMapCC(raw)
		if block == nil || stringFieldCC(block, "type") != "tool-call" {
			continue
		}
		callID := stringFieldCC(block, "id")
		if callID == "" {
			continue
		}
		calls = append(calls, AgentMemoryToolCall{
			ID:        callID,
			Type:      "function",
			Name:      firstNonEmptyCC(stringFieldCC(block, "name"), "unknown"),
			Arguments: Redact(argumentsStringCC(block["arguments"])),
		})
	}
	return calls
}
