/**
 * Message helpers — extract plain text and detect session-reset prompts.
 *
 * Mirrors the reference plugin's messages.js but trimmed: we only need
 * the bits the runtime engine actually uses (toText for query
 * extraction; isSessionResetPrompt to skip retrieval on /clear).
 */

// Channel-envelope strip. Hosts like OpenClaw / Feishu prepend
// untrusted-input wrappers to the user's actual message before
// forwarding it to the agent:
//   Sender (untrusted metadata):\n```json\n{"label": "openclaw-…"}\n```
//   [message_id: 1778…]\nsender_id: ou_xxx
//   [Mon 2026-05-13 22:16 GMT+8] …
// These legacy heuristics normalize retrieval queries, not stored dialogue.
// Write adapters must classify host metadata using native source structure;
// actual conversation text can intentionally quote these same strings.
//
// See EverMind-AI/EverOS#139 and the reference patterns in
// evermemos-openclaw-plugin/packages/plugin-local/src/messages.js.
const METADATA_BLOCK_PATTERNS = [
  // "Conversation info / Sender (untrusted metadata):" + fenced block.
  // Fence language tag is optional (```json / ```JSON / plain ```).
  /(?:Conversation info|Sender|会话信息|发送者)\s*(?:\(untrusted metadata\))?\s*:\s*```[a-zA-Z]*\s*[\s\S]*?```/gi,
  // [message_id: xxx] optionally followed by a `key: value` line
  // (sender_id / from / etc.). Use horizontal whitespace after `]`
  // so the optional newline + key:value clause can still match;
  // \s* would greedily consume the newline.
  /\[message_id:\s*[^\]]*\][ \t]*(?:\r?\n\s*[\w.-]+\s*:\s*[^\r\n]*)?/gi,
];

// Applied only as a leading prefix (after the blocks above are stripped).
// Day-of-week optional, seconds optional, TZ accepts GMT±N / UTC±N / ±HH:MM.
const LEADING_TIMESTAMP_PATTERN =
  /^\[(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+)?\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:\s+(?:GMT|UTC)[+-]\d+(?::\d{2})?|\s+[+-]\d{2}:?\d{2})?\]\s*/i;

/**
 * Remove legacy envelope patterns when normalizing a retrieval query.
 */
export function stripChannelMetadata(text) {
  if (!text) return text;
  let cleaned = text;
  for (const pattern of METADATA_BLOCK_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }
  // Trim first so the leading timestamp anchor (^) isn't blocked by
  // newlines left behind from the stripped blocks above.
  cleaned = cleaned.trim().replace(LEADING_TIMESTAMP_PATTERN, "");
  return cleaned.trim();
}

/**
 * Coerce a message-content value (string or part array) into a single
 * plain-text string with channel-envelope noise stripped. Part arrays
 * come from MCP / OpenClaw turns where content is a list of
 * { type, text } objects.
 */
export function toText(content) {
  return stripChannelMetadata(extractText(content));
}

// Conversation text can contain literal protocol examples; extraction must not strip them.
export function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : p?.text || p?.content || ""))
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object" && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

const RESET_TRIGGERS = [
  "/clear",
  "/reset",
  "/new",
  "start over",
  "新会话",
  "重新开始",
];

/**
 * `true` when the user's prompt indicates a fresh session and we should
 * skip memory retrieval for this turn.
 */
export function isSessionResetPrompt(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return false;
  return RESET_TRIGGERS.some((t) => q === t || q.startsWith(t + " "));
}
