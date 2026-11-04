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

// SeekMoonScanner parses SeekMoon (moonbitlang/openseek) conversation
// transcripts.
//
// SeekMoon keeps one JSONL file per conversation, inside the session directory
// of the workspace the conversation belongs to:
//
//	<workspace>/.openseek/sessions/<session-id>/openseek_session-<session-id>.jsonl
//
// There is no single home directory to scan — sessions live with their
// workspace — so the roots come from the desktop's own workspace registry
// (see seekMoonSessionRoots). The session directory also holds `jobs/`,
// `scratch/`, `session.lock` and `prediction.json`; none of them is a
// transcript.
//
// Line 1 is a session header carrying `version`, `id` and the full
// `system_prompt`. The prompt is instructions, not conversation, so it is
// dropped; `id` becomes the origin id the conversation id is derived from.
// Every later line is one record:
//
//	{"sequence":N,"ts":<ms>,"item":{"kind":"…","payload":{…}}}
//
// with these kinds:
//
//	user           payload.content, payload.submission_id
//	assistant      payload.content (may be empty), payload.tool_calls
//	               [{id,name,arguments}], payload.reasoning_content
//	               (internal chain-of-thought), payload.usage
//	tool_result    payload.tool_call_id, payload.tool_name, payload.content,
//	               payload.is_error, payload.brief, payload.data
//	runtime_notice payload.content — app notices (background jobs finishing)
//	terminal       payload.kind, payload.message — app state
//
// `reasoning_content` and the two bookkeeping kinds are skipped: like every
// other scanner here, only what the user actually saw is imported.
type SeekMoonScanner struct{}

var _ Scanner = (*SeekMoonScanner)(nil)

func NewSeekMoonScanner() *SeekMoonScanner { return &SeekMoonScanner{} }

func (s *SeekMoonScanner) Platform() PlatformID { return PlatformSeekMoon }

const (
	// seekMoonSessionFilePrefix marks a transcript; the session id follows.
	seekMoonSessionFilePrefix = "openseek_session-"
	seekMoonSessionFileSuffix = ".jsonl"
)

func (s *SeekMoonScanner) Scan(roots []string) ([]Item, error) {
	var items []Item
	for _, root := range roots {
		if _, err := os.Stat(root); os.IsNotExist(err) {
			continue
		}
		err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				// `jobs` keeps tool output, `scratch` the session's temp files;
				// neither holds a transcript.
				switch d.Name() {
				case "jobs", "scratch":
					return filepath.SkipDir
				}
				return nil
			}
			name := d.Name()
			if !strings.HasPrefix(name, seekMoonSessionFilePrefix) ||
				!strings.HasSuffix(name, seekMoonSessionFileSuffix) {
				return nil
			}
			info, infoErr := d.Info()
			if infoErr != nil || info == nil {
				return nil // skip unreadable entry
			}
			items = append(items, Item{
				Platform:  PlatformSeekMoon,
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

func (s *SeekMoonScanner) Read(item Item) (*Conversation, error) {
	f, err := os.Open(item.Path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	conv := &Conversation{Item: item}
	scanner := bufio.NewScanner(f)
	// A transcript records whole tool results (job output, file reads), so a
	// single line can be far past bufio's default cap.
	scanner.Buffer(make([]byte, 0, 1024*1024), 64*1024*1024)

	// File mtime is the deterministic fallback base for records that carry no
	// ts — never time.Now(), which would break re-import idempotency.
	var fallbackBase int64
	if fi, statErr := os.Stat(item.Path); statErr == nil {
		fallbackBase = fi.ModTime().UnixMilli()
	} else {
		fallbackBase = time.Unix(0, 0).UnixMilli()
	}

	const maxRunes = 8000
	lineNum := 0
	originID := ""

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

		item := objectMapCC(rec["item"])
		if item == nil {
			// Header line: keep the session id, drop the system prompt.
			if originID == "" {
				if id, ok := rec["id"].(string); ok {
					originID = strings.TrimSpace(id)
				}
			}
			continue
		}

		payload := objectMapCC(item["payload"])
		ts := normalizeTimestampCC(rec["ts"], fallbackBase+int64(lineNum))

		switch kind := stringFieldCC(item, "kind"); kind {
		case "user":
			text := truncateRunesCC(strings.TrimSpace(stringFieldCC(payload, "content")), maxRunes)
			if text == "" {
				continue
			}
			conv.Messages = append(conv.Messages, AgentMemoryMessage{
				Role:      "user",
				Timestamp: ts,
				Content:   Redact(text),
			})

		case "assistant":
			// One record can carry both prose and tool calls; keep them on a
			// single message so the tool call stays next to what asked for it.
			text := truncateRunesCC(strings.TrimSpace(stringFieldCC(payload, "content")), maxRunes)
			calls := seekMoonToolCalls(payload["tool_calls"], ts)
			if text == "" && len(calls) == 0 {
				// reasoning-only turn: nothing the user saw.
				continue
			}
			msg := AgentMemoryMessage{Role: "assistant", Timestamp: ts, ToolCalls: calls}
			if text != "" {
				msg.Content = Redact(text)
			}
			conv.Messages = append(conv.Messages, msg)

		case "tool_result":
			callID := strings.TrimSpace(stringFieldCC(payload, "tool_call_id"))
			if callID == "" {
				conv.Warnings = append(conv.Warnings, fmt.Sprintf("line %d: tool_result missing tool_call_id, dropped", lineNum))
				continue
			}
			text := truncateRunesCC(strings.TrimSpace(stringFieldCC(payload, "content")), maxRunes)
			if text == "" {
				text = "tool result"
			}
			conv.Messages = append(conv.Messages, AgentMemoryMessage{
				Role:       "tool",
				Timestamp:  ts,
				ToolCallID: callID,
				Content:    Redact(text),
			})

		case "runtime_notice", "terminal":
			// App bookkeeping (a background job finishing, a turn's terminal
			// state) — not something the user or the assistant said.

		default:
			if kind != "" {
				conv.Warnings = append(conv.Warnings, fmt.Sprintf("line %d: unknown record kind %q, skipped", lineNum, kind))
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	setStartedAtFromMessages(conv)
	conv.ID = ConversationID(PlatformSeekMoon, originID, item.Path)
	return conv, nil
}

// seekMoonToolCalls maps a record's tool_calls array onto the BFF shape.
// Arguments are JSON text in the transcript; Redact runs before they leave the
// machine like every other scanner's.
func seekMoonToolCalls(v any, ts int64) []AgentMemoryToolCall {
	raw, ok := v.([]any)
	if !ok || len(raw) == 0 {
		return nil
	}
	calls := make([]AgentMemoryToolCall, 0, len(raw))
	for i, entry := range raw {
		m := objectMapCC(entry)
		if m == nil {
			continue
		}
		calls = append(calls, AgentMemoryToolCall{
			ID:        firstNonEmptyCC(stringFieldCC(m, "id"), fmt.Sprintf("seekmoon_tool_%d_%d", ts, i)),
			Type:      "function",
			Name:      firstNonEmptyCC(stringFieldCC(m, "name"), "unknown"),
			Arguments: Redact(argumentsStringCC(m["arguments"])),
		})
	}
	if len(calls) == 0 {
		return nil
	}
	return calls
}

// seekMoonSessionRoots resolves one session root per workspace SeekMoon knows.
// The desktop records its workspaces in ~/.openseek/workspaces.json, and each
// workspace keeps its own sessions, so a single home-directory scan cannot see
// them. EVERCLI_SEEKMOON_WORKSPACES (path-list) overrides the registry, and
// EVERCLI_SEEKMOON_HOME moves the .openseek directory itself (tests).
func seekMoonSessionRoots() []string {
	if list := os.Getenv("EVERCLI_SEEKMOON_WORKSPACES"); list != "" {
		var roots []string
		for _, ws := range filepath.SplitList(list) {
			if ws = strings.TrimSpace(ws); ws != "" {
				roots = append(roots, seekMoonSessionsDir(ws))
			}
		}
		return roots
	}

	home, err := seekMoonHome()
	if err != nil {
		return nil
	}
	raw, err := os.ReadFile(filepath.Join(home, "workspaces.json"))
	if err != nil {
		return nil
	}
	var registry struct {
		Workspaces []string `json:"workspaces"`
	}
	if err := json.Unmarshal(raw, &registry); err != nil {
		return nil
	}
	roots := make([]string, 0, len(registry.Workspaces))
	for _, ws := range registry.Workspaces {
		if ws = strings.TrimSpace(ws); ws != "" {
			roots = append(roots, seekMoonSessionsDir(ws))
		}
	}
	return roots
}

// seekMoonSessionsDir is where one workspace keeps its session directories.
func seekMoonSessionsDir(workspace string) string {
	return filepath.Join(workspace, ".openseek", "sessions")
}

// seekMoonHome is the user-level .openseek directory, which holds the
// desktop's workspace registry. It is not the app runtime directory: that one
// (host-mcp.json, engine-settings.json) lives under Application Support.
func seekMoonHome() (string, error) {
	if dir := os.Getenv("EVERCLI_SEEKMOON_HOME"); dir != "" {
		return dir, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".openseek"), nil
}
