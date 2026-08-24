// Package conversation imports local agent sessions and md into EverMe
// agent-memory.
package conversation

type PlatformID string

const (
	PlatformClaudeCode PlatformID = "claude-code"
	PlatformCodex      PlatformID = "codex"
	PlatformHermes     PlatformID = "hermes"
	PlatformOpenClaw   PlatformID = "openclaw"
	PlatformMarkdown   PlatformID = "markdown"
	PlatformKimicode   PlatformID = "kimicode"
	PlatformRaven      PlatformID = "raven"
	PlatformWorkBuddy  PlatformID = "workbuddy"
)

// AgentMemoryToolCall mirrors the BFF /mem/agent-memory camelCase DTO.
type AgentMemoryToolCall struct {
	ID        string `json:"id"`
	Type      string `json:"type,omitempty"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// AgentMemoryMessage mirrors the BFF /mem/agent-memory message shape.
type AgentMemoryMessage struct {
	Role       string                `json:"role"`
	Timestamp  int64                 `json:"timestamp"`
	Content    any                   `json:"content,omitempty"`
	ToolCalls  []AgentMemoryToolCall `json:"toolCalls,omitempty"`
	ToolCallID string                `json:"toolCallId,omitempty"`
}

// Item is one discovered session/doc, surfaced in scan preview.
type Item struct {
	Platform        PlatformID `json:"platform"`
	Path            string     `json:"path"`
	OriginID        string     `json:"originId,omitempty"`
	StartedAt       string     `json:"startedAt,omitempty"` // ISO date for preview
	UpdatedAt       string     `json:"updatedAt,omitempty"`
	MessageCount    int        `json:"messageCount"`
	ToolCallCount   int        `json:"toolCallCount"`
	ToolResultCount int        `json:"toolResultCount"`
	SizeBytes       int64      `json:"sizeBytes"`
	Status          string     `json:"status"` // ready | unsupported | skipped | submitted (annotated by scan/run from local idempotency state)
	SkipReason      string     `json:"skipReason,omitempty"`
	// OwnerPlatform: for markdown items, the agent whose folder owns this
	// file; its evt is used for upload. Empty when the file is not under any
	// known agent folder.
	OwnerPlatform PlatformID `json:"ownerPlatform,omitempty"`
}

// Conversation is a parsed session ready to upload.
type Conversation struct {
	Item     Item                 `json:"item"`
	ID       string               `json:"conversationId"`
	Messages []AgentMemoryMessage `json:"messages"`
	Warnings []string             `json:"warnings,omitempty"`
}

// Scanner discovers and parses one platform's sessions.
type Scanner interface {
	Platform() PlatformID
	// Scan returns discovered items (path + date + counts), never errors on
	// a missing dir (returns nil items + a not-found note via Item.Status).
	Scan(roots []string) ([]Item, error)
	// Read parses one item into a Conversation. Tolerant: unknown lines ->
	// warnings, not fatal.
	Read(item Item) (*Conversation, error)
}
