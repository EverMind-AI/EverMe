import { flushAgentMemory, saveAgentMemory } from "../agent-memory.js";
import { createHookRuntime } from "./runtime-core.js";

export async function runStore({ input, adapter, client, config, counter, stateDir, log, diagnostic }) {
  const sessionId = input?.sessionId;
  if (!sessionId) return { block: "", count: 0 };
  const messages = await adapter.readLastTurn(input, { stateDir });
  if (!Array.isArray(messages) || !messages.length) return { block: "", count: 0 };
  const turnId = await resolveTurnId(adapter, input);
  const state = await counter.peek(sessionId, turnId);
  if (state.duplicate) return { block: "", count: 0, duplicate: true };

  const runtime = createHookRuntime({
    enqueue: (turn) => saveAgentMemory(client, turn, log),
    flush: (conversationId) => flushAgentMemory(client, { conversationId }, log),
    diagnostic,
    rethrowOnError: true,
  });
  if (config.flushMode === "legacy") {
    // Legacy mode restores the pre-cadence wire shape exactly: ONE request
    // per turn carrying the messages with flush:true. An add request plus a
    // separate empty flush is NOT equivalent — a flush ACK does not
    // guarantee the extraction was enqueued upstream, so the messages must
    // ride on the flushing request itself.
    const saved = await runtime.flushSession({ conversationId: sessionId, messages });
    await counter.commit(sessionId, turnId);
    return { block: "", count: messages.length, flushed: true, status: saved?.status, requestId: saved?.requestId };
  }
  const saved = await runtime.enqueueTurn({ conversationId: sessionId, messages });
  // Commit only after the gateway accepted the turn: committing first would
  // consume the turn id on a failed enqueue and dedupe away the retry.
  const committed = await counter.commit(sessionId, turnId);
  const flushed = config.flushEveryTurns > 0 && committed.count % config.flushEveryTurns === 0;
  let requestId = saved?.requestId;
  if (flushed) {
    const flushRes = await runtime.flush(sessionId);
    requestId = flushRes?.requestId || requestId;
  }
  return { block: "", count: messages.length, flushed, requestId };
}

// Hosts whose Stop payload carries no native turn id (Claude Code's
// documented Stop stdin has none) can expose resolveTurnId to derive a
// stable per-turn key from what they do have (e.g. the transcript's last
// event uuid). An empty result keeps the existing contract: empty turnId
// disables dedup for hosts with no better key.
async function resolveTurnId(adapter, input) {
  if (input?.turnId) return input.turnId;
  if (typeof adapter?.resolveTurnId !== "function") return "";
  return (await adapter.resolveTurnId(input)) || "";
}

export async function runBoundaryFlush({ input, adapter, client, sessionState, log, diagnostic }) {
  if (!input?.sessionId) return { block: "", count: 0 };
  const runtime = createHookRuntime({
    enqueue: (turn) => saveAgentMemory(client, turn, log),
    flush: (conversationId) => flushAgentMemory(client, { conversationId }, log),
    diagnostic,
    rethrowOnError: true,
  });
  if (typeof adapter?.readSession === "function") {
    // Whole-session hosts (kimi-code) register no per-turn Stop writer, so
    // the boundary is their single write and must carry every turn itself.
    const messages = await adapter.readSession(input);
    if (!Array.isArray(messages) || !messages.length) return { block: "", count: 0 };
    // High-water mark: SessionEnd can fire more than once for the same
    // session (re-fired boundary, resumed session ending again). Upload only
    // the messages past what a previous boundary already uploaded, and
    // advance the marker only after the upload succeeded. With no new
    // messages we skip entirely — no bare flush: the previous successful
    // upload already flushed, and a flush ACK does not guarantee extraction
    // enqueue upstream, so a bare re-flush adds noise without recovery value.
    const uploadedCount = sessionState ? (await sessionState.read(input.sessionId)).uploadedCount : 0;
    const delta = uploadedCount > 0 ? messages.slice(uploadedCount) : messages;
    if (!delta.length) return { block: "", count: 0, skipped: true };
    const saved = await runtime.flushSession({ conversationId: input.sessionId, messages: delta });
    // The high-water mark tracks UPLOAD dedup, not extraction: the gateway
    // accepted these messages, so re-sending them next boundary would
    // double-write. Extraction state travels separately via `status` —
    // "no_extraction" here means the upstream queued the session without
    // materialising it yet (v2 first-flush gap).
    if (sessionState) await sessionState.patch(input.sessionId, { uploadedCount: messages.length });
    return { block: "", count: delta.length, flushed: true, status: saved?.status, requestId: saved?.requestId };
  }
  const flushRes = await runtime.onSessionEnd(input.sessionId);
  return { block: "", count: 0, flushed: true, requestId: flushRes?.requestId };
}
