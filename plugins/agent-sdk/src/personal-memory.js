/**
 * Real-time personal (user) memory write path.
 *
 * Sibling of agent-memory.js. Where saveAgentMemory POSTs trajectories to
 * /mem/agent-memory (→ agent_case / agent_skill / episodic), this POSTs
 * plain user/assistant turns to /mem/personal (→ profile + episodic_memory).
 * The two are complementary: only this path lands a stated fact in the
 * user's profile, and it deliberately carries NO tool roles / tool_calls
 * — the personal endpoint ignores them.
 */

import { toText, stripChannelMetadata } from "./messages.js";
import { capRunes } from "./truncate.js";

const PERSONAL_MEMORY_ROLES = new Set(["user", "assistant"]);

export async function savePersonalMemory(client, { conversationId, messages = [], flush = true } = {}, log = { info() {}, warn() {} }) {
  if (!conversationId || !messages.length) return null;
  const stamp = Date.now();
  const converted = messages
    .map((m, i) => convertPersonalMessage(m, stamp + i))
    .filter(Boolean);
  if (!converted.length) return null;

  const res = await client.request("POST", "/mem/personal", {
    conversationId,
    messages: converted,
    flush,
  });
  log.info?.(`[everme] savePersonalMemory ok: messages=${converted.length} flushed=${Boolean(res?.flushed)}`);
  return res;
}

export function convertPersonalMessage(msg, fallbackTimestamp) {
  if (!msg || !PERSONAL_MEMORY_ROLES.has(msg.role)) return null;
  // Assistant text can echo the channel envelope; strip it on the write
  // side the same way agent-memory.js does.
  const content = cap(stripChannelMetadata(toText(msg.content)));
  if (!content) return null;
  return {
    role: msg.role,
    timestamp: normalizeTimestamp(msg.timestamp, fallbackTimestamp),
    content,
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
