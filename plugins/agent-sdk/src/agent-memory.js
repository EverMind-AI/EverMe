/**
 * Real-time agent memory write path.
 *
 * Converts raw OpenClaw messages into the EverMe gateway's /mem/agent-memory
 * shape while preserving assistant tool calls and tool results.
 */

import { toText, stripChannelMetadata } from "./messages.js";
import { capRunes } from "./truncate.js";

export const AGENT_MEMORY_ROLES = Object.freeze({
  USER: "user",
  ASSISTANT: "assistant",
  TOOL: "tool",
  TOOL_RESULT: "toolResult",
});

export const AGENT_MEMORY_TOOL_CALL_TYPES = Object.freeze({
  FUNCTION: "function",
});

export async function saveAgentMemory(client, { conversationId, messages = [], flush = true } = {}, log = { info() {}, warn() {} }) {
  if (!conversationId || !messages.length) return null;
  const stamp = Date.now();
  const converted = messages
    .map((m, i) => convertAgentMessage(m, stamp + i))
    .filter(Boolean)
    .filter((m) => m.content != null || (m.toolCalls && m.toolCalls.length));
  if (!converted.length) return null;

  const res = await client.request("POST", "/mem/agent-memory", {
    conversationId,
    messages: converted,
    flush,
  });
  log.info?.(`[everme] saveAgentMemory ok: messages=${converted.length} flushed=${Boolean(res?.flushed)}`);
  return res;
}

export function convertAgentMessage(msg, fallbackTimestamp) {
  if (!msg || !msg.role) return null;
  const timestamp = normalizeTimestamp(msg.timestamp, fallbackTimestamp);
  if (msg.role === AGENT_MEMORY_ROLES.USER) {
    const content = cap(toText(msg.content));
    return content ? { role: AGENT_MEMORY_ROLES.USER, timestamp, content } : null;
  }
  if (msg.role === AGENT_MEMORY_ROLES.ASSISTANT) {
    return convertAssistant(msg, timestamp);
  }
  if (msg.role === AGENT_MEMORY_ROLES.TOOL || msg.role === AGENT_MEMORY_ROLES.TOOL_RESULT) {
    const toolCallId = msg.toolCallId || msg.tool_call_id;
    if (!toolCallId) return null;
    return {
      role: AGENT_MEMORY_ROLES.TOOL,
      timestamp,
      toolCallId,
      content: cap(toText(msg.content)),
    };
  }
  return null;
}

function convertAssistant(msg, timestamp) {
  const textParts = [];
  const toolCalls = [];
  if (typeof msg.content === "string") textParts.push(msg.content);
  for (const block of Array.isArray(msg.content) ? msg.content : []) {
    if (!block || !block.type) continue;
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
      continue;
    }
    if (block.type === "toolCall" || block.type === "tool_use") {
      const args = block.arguments ?? block.input ?? {};
      toolCalls.push({
        id: block.id,
        type: AGENT_MEMORY_TOOL_CALL_TYPES.FUNCTION,
        name: block.name ?? "unknown",
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      });
    }
  }
  // Callers that pre-extracted toolCalls (e.g. claude-code's
  // extractAgentMessages, which has to walk CC's nested transcript
  // schema before we see it) pass them in alongside a string content.
  // Without this merge their toolCalls would be silently dropped here,
  // which is exactly how the realtime path lost every tool round-trip
  // for a year (Stop hook silent-fail bug). Normalise the incoming
  // shape so id/name/arguments survive whatever schema variant.
  if (Array.isArray(msg.toolCalls)) {
    for (const tc of msg.toolCalls) {
      if (!tc || !tc.id) continue;
      const args = tc.arguments ?? tc.input ?? "{}";
      toolCalls.push({
        id: tc.id,
        type: tc.type || AGENT_MEMORY_TOOL_CALL_TYPES.FUNCTION,
        name: tc.name ?? tc.function?.name ?? "unknown",
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      });
    }
  }
  // Strip channel envelope from assistant text too: an LLM that
  // echoes the user's enveloped input (or re-emits a tool result that
  // included it) would otherwise re-introduce the noise on the write
  // side that toText already removes on the read side. Tool-call
  // arguments are NOT stripped — those are structured JSON, not free
  // text, and stripping would corrupt them.
  const content = cap(stripChannelMetadata(textParts.join("\n")));
  if (!content && !toolCalls.length) return null;
  return {
    role: AGENT_MEMORY_ROLES.ASSISTANT,
    timestamp,
    ...(content ? { content } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
  };
}

function normalizeTimestamp(ts, fallback) {
  if (typeof ts === "number" && Number.isFinite(ts)) {
    return ts > 10_000_000_000 ? Math.trunc(ts) : Math.trunc(ts * 1000);
  }
  const parsed = Date.parse(ts);
  if (Number.isFinite(parsed)) return parsed;
  return fallback;
}

function cap(text) {
  return capRunes(text);
}
