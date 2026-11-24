/**
 * Real-time agent memory write path.
 *
 * Converts raw OpenClaw messages into the EverMe gateway's /mem/agent-memory
 * shape while preserving assistant tool calls and tool results.
 */

import { boundedDiagnostic, requestMeta } from "./client.js";
import { extractText } from "./messages.js";
import { capRunes } from "./truncate.js";
import { batchAgentMessages } from "./agent-batches.js";
import { batchUserTasks } from "./task-batches.js";
import { turnOrdinals, completedTurns } from "./turns.js";
import { dropEvermeMemoryToolPairs } from "./everme-injection.js";
import { createMemoryTimestampLedger, hostTimestamp, resolveFallbackTimestamps } from "./timestamps.js";

// Callers that pass no ledger still resend with stable fallbacks within this
// process; the hook runtime passes a file ledger so later processes do too.
const processTimestampLedger = createMemoryTimestampLedger();

export const AGENT_MEMORY_ROLES = Object.freeze({
  USER: "user",
  ASSISTANT: "assistant",
  TOOL: "tool",
  TOOL_RESULT: "toolResult",
});

export const AGENT_MEMORY_TOOL_CALL_TYPES = Object.freeze({
  FUNCTION: "function",
});

// The gateway rejects any /mem/agent-memory request carrying more than this
// many messages. Keep in sync with the server-side validation limit.
export const MAX_MESSAGES_PER_REQUEST = 500;

const LOG_ID_MAX_CHARS = 128;
const LOG_ERROR_MAX_CHARS = 240;

function logValue(value, maxChars = LOG_ID_MAX_CHARS) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

// `channel` is the writer's claim on the session gate ("hook" for the hook
// runtime). It is opt-in on purpose: an unclaimed write is still trimmed
// against session watermarks but never advances them, and the gateway counts
// it as source="unknown" — which is exactly right for MCP save_turn and any
// other caller that does not report turn losses. Only writers that take part
// in loss reporting (hooks) should claim, or L1-2 gains denominator without
// numerator.
//
// `turns` is the caller's declaration of how many logical turns this write
// completes, forwarded on the last batch only (leading batches send 0). It is
// never derived from the messages here: only the caller knows what a turn is,
// and a whole-session upload of a thousand user messages would otherwise
// declare a count the gateway rejects. The Stop path declares 1; callers
// without a loss reporter declare nothing and are counted once per request.
// `baseTurn` is the whole-session turn ordinal of messages[0] (see turns.js).
// A writer that knows it -- any host holding the full transcript plus a
// checkpoint of what it already uploaded -- lets the gate trim and advance by
// exact turn position, so a later import of the same session dedupes against
// what the hook landed instead of re-sending it. With baseTurn the batches are
// turn-aligned and `turns` is derived per batch as the turns that batch
// COMPLETES (a caller's `turns` is ignored): that is the count the gate moves
// the watermark by, and a batch cut mid-turn must not claim its open turn.
// Without baseTurn nothing changes: legacy batching, the caller's declaration.
//
// `timestampLedger` keeps the fallback timestamps of host messages that carry
// none stable across resends (see timestamps.js); without one the process
// ledger is used. `timeoutMs` overrides the client's per-request timeout for
// the write requests, for detached workers that can wait longer than a hook.
export async function saveAgentMemory(client, { conversationId, messages = [], flush = true, sync = false, channel, turns, baseTurn, taskBatching = false, deduplication, syncScope, timestampLedger, timeoutMs } = {}, log = { info() {}, warn() {} }) {
  if (!conversationId) {
    log.info?.("[everme] agent-memory stage=skip reason=missing_conversation_id");
    return null;
  }
  const flushOnly = flush === true && messages.length === 0;
  const stamp = Date.now();
  // Runs before conversion, while the source messages still carry the host's
  // own provenance (an MCP namespace is source-local and never reaches the
  // wire shape).
  messages = dropEvermeMemoryToolPairs(messages);
  let fallbacks;
  try {
    fallbacks = await resolveFallbackTimestamps({
      conversationId,
      messages,
      ledger: timestampLedger || processTimestampLedger,
      now: stamp,
    });
  } catch (error) {
    // A ledger that cannot be read or locked must not cost the turn. The
    // write goes out with fresh fallbacks, which only risks a duplicate if
    // this send is retried.
    log.warn?.(`[everme] agent-memory stage=timestamps result=degraded conversationId=${logValue(conversationId)} error=${boundedDiagnostic(error, LOG_ERROR_MAX_CHARS)}`);
    fallbacks = messages.map((_, i) => stamp + i);
  }
  const entries = messages
    .map((source, i) => ({ source, message: convertAgentMessage(source, fallbacks[i] ?? stamp + i) }))
    .filter(({ message }) => message && (message.content != null || message.toolCalls?.length));
  const converted = entries.map(({ message }) => message);
  if (!converted.length && !flushOnly) {
    log.info?.(`[everme] agent-memory stage=skip reason=no_parseable_messages conversationId=${logValue(conversationId)} inputMessages=${messages.length}`);
    return null;
  }
  if (syncScope) {
    await requireSyncScopeSupport(client, conversationId, syncScope, channel);
  }

  // Whole-session uploads (e.g. a kimicode SessionEnd) can exceed the
  // gateway's per-request message cap, which would reject — and lose — the
  // entire session. Split into sequential batches; only the final batch
  // carries the caller's flush flag so extraction sees the complete session,
  // not a partial prefix. A mid-batch failure throws and surfaces to the
  // caller instead of pretending the upload succeeded.
  const hasBase = Number.isInteger(baseTurn) && baseTurn >= 0;
  const metadata = entries.map(({ source }) => source);
  const slices = taskBatching
    ? batchUserTasks(converted, metadata, log)
    : batchAgentMessages(converted, MAX_MESSAGES_PER_REQUEST, metadata, hasBase);
  if (flushOnly) slices.push([]);
  const ordinals = hasBase ? turnOrdinals(converted) : null;
  const batches = slices.length;
  if (batches > 1) {
    log.info?.(`[everme] agent-memory stage=start conversationId=${logValue(conversationId)} messages=${converted.length} batches=${batches} flush=${flush === true}`);
  }
  // A declared count rides on the last batch only: a split write whose final
  // batch fails is a lost turn, not a delivered one.
  const declaredTurns = Number.isInteger(turns) && turns >= 0 ? turns : null;
  let res = null;
  const requestIds = [];
  let offset = 0;
  for (let batch = 0; batch < batches; batch += 1) {
    const slice = slices[batch];
    const isLast = batch === batches - 1;
    const sliceBase = hasBase ? baseTurn + (ordinals[offset] ?? 0) : null;
    const sliceTurns = hasBase ? completedTurns(slices, batch, baseTurn) : null;
    offset += slice.length;
    try {
      const { result, requestId } = await requestMeta(client, "POST", "/mem/agent-memory", {
        conversationId,
        messages: slice,
        flush: isLast ? flush : false,
        // Leading batches of a flushing upload must keep the server's
        // synchronous-add guarantee: an async leading batch can still be
        // invisible to the final request's flush (first-flush data loss,
        // one request boundary later). Servers without the field ignore it.
        ...(sync === true || (!isLast && flush === true) ? { sync: true } : {}),
        ...(channel ? { channel } : {}),
        ...(syncScope ? { syncScope } : {}),
        ...(deduplication ? { deduplication } : {}),
        ...(hasBase
          ? { baseTurn: sliceBase, turns: sliceTurns }
          : (declaredTurns !== null && slice.length ? { turns: isLast ? declaredTurns : 0 } : {})),
      }, ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? [{ timeoutMs }] : []));
      res = result;
      requestIds.push(requestId);
      if (batches > 1) {
        log.info?.(`[everme] agent-memory stage=batch result=accepted conversationId=${logValue(conversationId)} batch=${batch + 1}/${batches} messages=${slice.length} requestId=${logValue(requestId)}`);
      }
    } catch (error) {
      if (batches > 1) {
        log.warn?.(`[everme] agent-memory stage=batch result=failed conversationId=${logValue(conversationId)} batch=${batch + 1}/${batches} messages=${slice.length} error=${boundedDiagnostic(error, LOG_ERROR_MAX_CHARS)}`);
      }
      throw error;
    }
  }
  const lastRequestId = requestIds[requestIds.length - 1] || "";
  log.info?.(`[everme] agent-memory stage=complete result=accepted conversationId=${logValue(conversationId)} messages=${converted.length} batches=${batches} flushed=${Boolean(res?.flushed)} status=${logValue(res?.status)} requestId=${logValue(lastRequestId)} requestIdCount=${requestIds.filter(Boolean).length}`);
  return res == null ? res : { ...res, requestId: requestIds[requestIds.length - 1], requestIds };
}

async function requireSyncScopeSupport(client, conversationId, syncScope, channel) {
  const { result } = await requestMeta(client, "POST", "/mem/agent-memory/state", {
    sessions: [{ conversationId, syncScope }],
  });
  const supported = channel === "hook"
    ? result?.hookSyncScopeSupported === true
    : channel === "import" && result?.syncScopeSupported === true;
  if (!supported) {
    throw new Error("Agent memory sync scope is not supported for this channel; upgrade the EverMe server before retrying");
  }
}

export async function flushAgentMemory(client, { conversationId, timeoutMs } = {}, log) {
  return saveAgentMemory(client, { conversationId, messages: [], flush: true, timeoutMs }, log);
}

export function convertAgentMessage(msg, fallbackTimestamp) {
  if (!msg || !msg.role) return null;
  const timestamp = hostTimestamp(msg.timestamp) ?? fallbackTimestamp;
  if (msg.role === AGENT_MEMORY_ROLES.USER) {
    const content = cap(extractText(msg.content).trim());
    if (content) return { role: AGENT_MEMORY_ROLES.USER, timestamp, content };
    // A host record that earlier releases uploaded as a user turn but that is
    // not the person's words (a background notice, a compaction summary). It
    // still occupies its turn: the gate counts user messages to place turns
    // and the server drops empty content before EverOS, so the turn positions
    // stay where earlier releases put them while the text never reaches memory.
    return msg.placeholder === true ? { role: AGENT_MEMORY_ROLES.USER, timestamp, content: "" } : null;
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
      content: extractText(msg.content).trim(),
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
  // Host adapters classify control records; assistant text may quote them.
  const content = cap(textParts.join("\n").trim());
  if (!content && !toolCalls.length) return null;
  return {
    role: AGENT_MEMORY_ROLES.ASSISTANT,
    timestamp,
    ...(content ? { content } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(typeof msg.turnComplete === "boolean" ? { turnComplete: msg.turnComplete } : {}),
  };
}

function cap(text) {
  return capRunes(text);
}
