/**
 * OpenClaw ContextEngine adapter — bridges the OpenClaw lifecycle hooks
 * to the EverMe HTTP surface (search/context for read, realtime agent-memory
 * for write).
 *
 * Lifecycle compared to the reference EverOS plugin (plugin-local):
 *
 *   bootstrap   — assert config, init session state
 *   afterTurn   — write the raw turn through /mem/agent-memory
 *   commitTurn  — OpenClaw 2026.8+: acknowledge the host's accepted turn,
 *                 writing whatever afterTurn did not already write
 *   assemble    — call getContext or searchMemory, render prompt
 *   compact     — flush pending extraction before local compaction
 *   dispose     — best-effort bounded flush
 *
 * Cold-start memory (the bulk of the user's history) is uploaded by
 * evercli `import run` BEFORE the agent ever starts. This plugin only
 * handles the live conversation turn-by-turn.
 */

import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import {
  resolveConfig,
  assertConfigUsable,
  createClient,
  redactError,
  describeError,
  flushAgentMemory,
  saveAgentMemory,
  searchMemory,
  filterEpisodesByScore,
  toText,
  extractText,
  isSessionResetPrompt,
  buildMemoryPrompt,
  extractUserIntent,
  formatQueryStats,
  AGENT_MEMORY_ROLES,
} from "@everme/agent-sdk";

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2h, matches reference
const DISPOSE_FLUSH_TIMEOUT_MS = 3000;
// Message keys remembered per session for the afterTurn/commitTurn overlap
// and for turn claims, and accepted turns remembered per agent for host
// retries.
const UPLOADED_KEYS_MAX = 2000;
const COMMITTED_TURNS_MAX = 2000;
// A failed commitTurn throws once so the host keeps the turn in its outbox
// and retries it before the next turn; the next failure gives the turn up,
// because a turn the host still holds degrades the session to "legacy".
const COMMIT_MAX_ATTEMPTS = 2;

// OpenClaw resolves the engine through its factory for every run and disposes
// it when the run ends (2026.7 and 2026.8 both do). Cursors and ledgers that
// must outlive one turn therefore live here, keyed by backend and agent.
const sharedSessions = new Map(); // scope\0sessionKey → { lastActive, savedUpTo, turnCount, uploaded, claimed, writing }
const committedTurns = new Map(); // scope\0advancementKey → committedAt
const commitAttempts = new Map(); // scope\0advancementKey → failed attempts

// This is a host-native integration (OpenClaw ContextEngine lifecycle), not
// an MCP transport, so it declares the same "hook" kind as the native hooks.
const PKG_VERSION = createRequire(import.meta.url)("../package.json").version;

export function createContextEngine(pluginMeta, hostConfig, hostLogger) {
  const log = hostLogger || { info() {}, warn() {} };
  const cfg = resolveConfig({ ...hostConfig, clientKind: "hook", clientVersion: PKG_VERSION });
  assertConfigUsable(cfg);

  const client = createClient(cfg, log);
  const L = `[${pluginMeta.id}]`;
  // engineId: short tag the engine instance carries for the duration
  // of its life. Every log line emitted by this instance tags itself
  // with it, so we can tell from the log whether the host keeps one
  // engine across turns or constructs a fresh one each time (which
  // determines whether in-memory state like turnCount can be trusted
  // between calls). UUID prefix is fixed-length and collision-resistant.
  const engineId = randomUUID().slice(0, 8);
  log.info(
    `${L} ContextEngine boot[${engineId}]: baseUrl=${cfg.baseUrl} agentId=${cfg.agentId} ` +
      `flushEveryTurns=${cfg.flushEveryTurns} flushMaxBytes=${cfg.flushMaxBytes}`,
  );

  const scope = `${cfg.baseUrl}\u0000${cfg.agentId}`;
  // Sessions this instance touched: dispose flushes these, not every session
  // another turn's engine is still serving.
  const touched = new Set();

  // pruneStale evicts inactive cursors only. It must not flush to
  // /mem/sources; OpenClaw runtime persistence is realtime-only.
  function pruneStale() {
    const now = Date.now();
    for (const [k, v] of sharedSessions) {
      if (now - v.lastActive <= SESSION_TTL_MS) continue;
      sharedSessions.delete(k);
      log.info?.(`${L} pruneStale: evicted session cursor ${k.split("\u0000").pop()}`);
    }
  }

  function ensure(sessionKey) {
    const key = `${scope}\u0000${sessionKey}`;
    let s = sharedSessions.get(key);
    if (!s) {
      s = { lastActive: Date.now(), savedUpTo: 0, turnCount: 0, uploaded: new Set(), claimed: new Set(), writing: Promise.resolve() };
      sharedSessions.set(key, s);
    } else {
      s.lastActive = Date.now();
    }
    touched.add(sessionKey);
    return s;
  }

  // persistTurn writes one finished turn and advances the session cursor.
  // `fresh` marks a tail that is the whole session so far (turn 0).
  async function persistTurn(sessionKey, s, tail, { fresh }) {
    const nextTurn = s.turnCount + 1;
    // Flush gating: EverOS keeps un-flushed writes as raw_messages
    // (queryable via memory_types=raw_message) and only promotes them
    // to episodic_memory / profile on an explicit flush. Flushing on
    // every turn pays the extraction cost on the host's hot path AND
    // makes the raw_messages channel always empty. Flushing every N
    // turns (config: flushEveryTurns) lets recent turns live as raw
    // context for the next prompt while still building up episodes
    // periodically.
    //
    // Nth turn semantics: turnCount becomes N after this call, so we
    // gate on the post-increment value to flush on turn N, 2N, 3N, ... .
    // flushEveryTurns=0 keeps the "never auto-flush" escape hatch.
    const flush = cfg.flushEveryTurns > 0 && nextTurn % cfg.flushEveryTurns === 0;
    // The tail holds the turn(s) the host just finished, so its user
    // messages are the turns this write completes. Claiming them lets the
    // session gate advance the watermark past them, so the importer's later
    // scan of the same session is trimmed instead of stored twice.
    //
    // Cold-start rule (same as Claude Code's adapter): the first write of a
    // session in this process claims nothing when the snapshot holds
    // anything before the tail -- history the hook never saw (plugin loaded
    // mid-session, gateway restarted), possibly already compacted into a
    // summary. Claiming there would ask the gate to record this turn as
    // turn 0 and the importer would trim the real turn 0 as covered;
    // unclaimed, the write lands without moving the turn watermark and the
    // importer brings the history in from turn 0. A snapshot that IS the
    // tail is the session's first turn: that write is addressed at turn 0,
    // which anchors the ledger row for the appends that follow.
    //
    // A user message is claimed once. A retry carries the turn of a write
    // that failed; if that write may have landed (a timeout, a dropped
    // connection), its claim may have moved the watermark already, and a
    // second claim would move it past a turn that never happened.
    const coldStart = s.turnCount === 0 && !fresh;
    const claim = coldStart
      ? []
      : tail.filter((message) => message?.role === AGENT_MEMORY_ROLES.USER && !s.claimed.has(messageKey(message)));
    let saved;
    try {
      saved = await saveAgentMemory(client, {
        conversationId: sessionKey,
        messages: tail,
        taskBatching: true,
        flush,
        // The host snapshot can compact; its indices are not durable turn
        // coordinates, so no baseTurn past the first turn: the gate appends
        // the claimed turns at its current watermark instead.
        channel: "hook",
        // Without baseTurn the gate would trim by time and drop any message
        // older than the newest one the session already landed. This plugin
        // owns its re-send protection (the cursor, the uploaded keys and the
        // commit ledger), and a re-send that gets through carries the host's
        // own timestamps, so EverOS skips it by message id.
        deduplication: "client-native-id",
        turns: claim.length,
        ...(fresh && s.turnCount === 0 ? { baseTurn: 0 } : {}),
      }, log);
    } catch (err) {
      // An error the server answered applied nothing, so the retry may claim
      // these turns again. Any other failure may have landed the write.
      if (!(err?.code > 0)) rememberKeys(s.claimed, claim);
      throw err;
    }
    s.turnCount = nextTurn;
    rememberUploaded(s, tail);
    rememberKeys(s.claimed, claim);
    return { saved, flush };
  }

  // afterTurn and commitTurn can run at the same time for one turn: OpenClaw
  // hands a turn still in its outbox to the next run's engine while the run
  // that produced it is still committing it. Both would find nothing uploaded
  // yet, write the turn twice and claim it twice. Each session's writes
  // therefore run one at a time, and each reads the cursor and the uploaded
  // keys only after the previous write has settled.
  async function afterTurnLocked(sessionKey, s, messages, prePromptMessageCount) {
    const allMessages = messages || [];
    if (s.savedUpTo > allMessages.length) s.savedUpTo = 0;
    const sliceStart = prePromptMessageCount !== undefined
      ? prePromptMessageCount
      : s.savedUpTo || 0;
    const rawTail = sliceStart > 0 ? allMessages.slice(sliceStart) : lastUserTurn(allMessages);
    const tail = canonicalTurnMessages(rawTail, log);
    if (!tail.length) return;

    if (cfg.flushEveryTurns === 0 && cfg.flushMaxBytes === 0) {
      s.turnCount += 1;
      s.savedUpTo = allMessages.length;
      rememberUploaded(s, tail);
      return;
    }

    // Trajectory-shape telemetry. EverOS only extracts agent_case /
    // agent_skill from trajectories that actually carry tool round-
    // trips (assistant with tool_calls + tool with toolCallId). If
    // every afterTurn shows tools=0/0 we know the upstream host runtime
    // is stripping tool_use before it reaches the SDK, and no amount
    // of downstream fixing will produce case/skill. Keep it at info so
    // it shows up alongside the existing save line without needing a
    // debug toggle.
    const shape = trajectoryShape(tail);
    try {
      const { saved, flush } = await persistTurn(sessionKey, s, tail, {
        fresh: rawTail.length === allMessages.length,
      });
      s.savedUpTo = allMessages.length;
      log.info?.(`${L} afterTurn[${engineId}]: saved ${tail.length} messages via agent-memory, sessionKey=${sessionKey} turn=${s.turnCount} flushed=${flush} shape=${shape} requestId=${saved?.requestId || ""}`);
    } catch (err) {
      // Leave turnCount/savedUpTo untouched so the same tail retries
      // on the next afterTurn — bumping them here would skip the
      // natural retry slot and could starve a flush turn if EverOS
      // keeps failing.
      log.warn(`${L} afterTurn realtime save failed: ${describeError(err)}`);
    }
  }

  async function commitTurnLocked(ledgerKey, advancementKey, sessionKey, s, messages) {
    // A commit of the same turn can have finished while this one waited.
    if (committedTurns.has(ledgerKey)) {
      log.info?.(`${L} commitTurn[${engineId}]: duplicate advancementKey=${advancementKey}, nothing written`);
      return { status: "duplicate" };
    }
    const tail = canonicalTurnMessages(messages || [], log);
    const pending = tail.filter((message) => !s.uploaded.has(messageKey(message)));
    if (!pending.length || (cfg.flushEveryTurns === 0 && cfg.flushMaxBytes === 0)) {
      rememberUploaded(s, tail);
      rememberCommitted(ledgerKey);
      log.info?.(`${L} commitTurn[${engineId}]: nothing new to write, sessionKey=${sessionKey} messages=${tail.length}`);
      return { status: "committed" };
    }
    try {
      // Under the current-turn fence, assemble saw exactly the history
      // before this turn's user entry: none means this is the session's
      // first turn. Without that sighting the commit claims nothing (the
      // cold-start rule in persistTurn).
      const { saved, flush } = await persistTurn(sessionKey, s, pending, {
        fresh: s.historyBeforeTurn === 0 && pending.length === tail.length,
      });
      rememberCommitted(ledgerKey);
      log.info?.(`${L} commitTurn[${engineId}]: saved ${pending.length} of ${tail.length} messages via agent-memory, sessionKey=${sessionKey} turn=${s.turnCount} flushed=${flush} shape=${trajectoryShape(pending)} requestId=${saved?.requestId || ""}`);
      return { status: "committed" };
    } catch (err) {
      const attempts = (commitAttempts.get(ledgerKey) || 0) + 1;
      if (attempts < COMMIT_MAX_ATTEMPTS) {
        commitAttempts.set(ledgerKey, attempts);
        log.warn(`${L} commitTurn realtime save failed, the host will retry: ${describeError(err)}`);
        throw new Error(redactError(err));
      }
      commitAttempts.delete(ledgerKey);
      rememberCommitted(ledgerKey);
      log.warn(`${L} commitTurn realtime save failed ${attempts} times, turn dropped: ${describeError(err)}`);
      return { status: "committed" };
    }
  }

  return {
    info: {
      id: pluginMeta.id,
      name: pluginMeta.name,
      version: pluginMeta.version,
      ownsCompaction: false,
      // OpenClaw 2026.8+ runs a non-legacy engine on an admitted turn only
      // when it declares both and implements commitTurn; otherwise the whole
      // turn falls back to "legacy" and EverMe is never called. Older hosts
      // ignore the field.
      transcriptSemantics: {
        currentTurnFence: "before-current-turn-entry-v1",
        turnAdvancementIdempotency: "atomic-idempotent-v1",
      },
    },

    async bootstrap({ sessionKey } = {}) {
      pruneStale();
      if (sessionKey) ensure(sessionKey);
      return { bootstrapped: true };
    },

    async ingest({ sessionKey, message, isHeartbeat }) {
      if (isHeartbeat) return { ingested: false };
      if (sessionKey) ensure(sessionKey);
      return { ingested: true };
    },

    async ingestBatch({ sessionKey, messages, isHeartbeat }) {
      if (isHeartbeat) return { ingestedCount: 0 };
      if (sessionKey) ensure(sessionKey);
      return { ingestedCount: messages?.length || 0 };
    },

    /**
     * After every host turn, persist the raw trajectory through the realtime
     * agent-memory API. Do not fall back to /mem/sources on failure: that path
     * creates document sources and is reserved for import / document writes.
     */
    async afterTurn({ sessionKey, messages, prePromptMessageCount, isHeartbeat } = {}) {
      if (isHeartbeat || !sessionKey) return;
      pruneStale();
      const s = ensure(sessionKey);
      await serialized(s, () => afterTurnLocked(sessionKey, s, messages, prePromptMessageCount));
    },

    /**
     * OpenClaw 2026.8+ hands over each accepted turn here, keyed by
     * advancementKey, and retries it from a durable outbox until this returns
     * "committed" or "duplicate". A host can also run afterTurn on the same
     * turn first, so this writes only the messages afterTurn has not already
     * written.
     */
    async commitTurn({ advancementKey, sessionKey, messages, isHeartbeat } = {}) {
      const ledgerKey = `${scope}\u0000${advancementKey}`;
      if (committedTurns.has(ledgerKey)) {
        log.info?.(`${L} commitTurn[${engineId}]: duplicate advancementKey=${advancementKey}, nothing written`);
        return { status: "duplicate" };
      }
      if (isHeartbeat || !sessionKey) {
        rememberCommitted(ledgerKey);
        return { status: "committed" };
      }
      pruneStale();
      const s = ensure(sessionKey);
      return serialized(s, () => commitTurnLocked(ledgerKey, advancementKey, sessionKey, s, messages));
    },
    /**
     * Right before the model runs, fetch a relevant context block and
     * return it as systemPromptAddition. We call POST /mem/search with
     * the EverMe default `memoryTypes` (episodic_memory + profile +
     * raw_message + agent_memory) — that one call returns every signal
     * type ranked by query relevance, so the prompt sees recent un-
     * flushed turns alongside curated episodes/profile/skills.
     *
     * /mem/context (a non-query profile snapshot) is intentionally NOT
     * used here: it can only return the curated profile and would
     * shadow the raw_messages + agent_memory sections from /mem/search.
     * If a host needs the snapshot it can call /mem/context directly
     * (Claude Code's session-start hook does this).
     */
    async assemble({ sessionKey, messages, prompt } = {}) {
      pruneStale();
      if (sessionKey) ensure(sessionKey).historyBeforeTurn = (messages || []).length;

      // The host prompt is an assembled message, not a question: it can carry
      // injected skill content, reminder blocks, and — because OpenClaw echoes
      // the previous user message — our own memory block from last turn. Feed
      // the extracted intent to /mem/search instead, and log the reduction so
      // the noise contribution of this host is measurable rather than assumed.
      const raw = stripLobsterAIWrapper(toText(prompt) || toText(lastUser(messages || [])?.content));
      const { query, stats } = extractUserIntent(raw);
      log.info?.(`${L} assemble[${engineId}]: recall query ${formatQueryStats(stats)}`);
      if (!query || query.length < 3) return { messages, estimatedTokens: 0 };
      if (isSessionResetPrompt(query)) return { messages, estimatedTokens: 0 };

      try {
        // assemble is per-turn auto-injection, the same job the
        // UserPromptSubmit hook does — so it takes the recall knobs
        // (injectTopK / injectMinScore), not the host-level cfg.topK that
        // serves agent-initiated MCP searches. It used to read cfg.topK and
        // apply no floor at all, which left this host at 10 rows unfiltered
        // while the hook path tightened.
        const res = await searchMemory(
          client,
          { query, topK: cfg.injectTopK },
          log,
        );
        const bundle = {
          ...res,
          memories: filterEpisodesByScore(res.memories, cfg.injectMinScore),
        };
        // Cases are absent on purpose: buildMemoryPrompt no longer renders
        // them, so counting them here would only let an all-cases response
        // pass this gate and then render an empty block.
        const hasAny =
          bundle.memories?.length ||
          bundle.profiles?.length ||
          bundle.rawMessages?.length ||
          bundle.agentMemory?.skills?.length;
        if (!hasAny) return { messages, estimatedTokens: 0 };
        const block = buildMemoryPrompt(bundle, { wrapInCodeBlock: true });
        if (!block) return { messages, estimatedTokens: 0 };
        return {
          messages,
          estimatedTokens: Math.floor(block.length / 4),
          systemPromptAddition: block,
        };
      } catch (err) {
        log.warn(`${L} assemble /mem/search failed: ${describeError(err)}`);
        return { messages, estimatedTokens: 0 };
      }
    },

    async compact({ sessionKey } = {}) {
      if (sessionKey) ensure(sessionKey);
      if (sessionKey) {
        try {
          await flushAgentMemory(client, { conversationId: sessionKey }, log);
        } catch (err) {
          log.warn(`${L} compact flush failed: ${describeError(err)}`);
        }
      }
      return { ok: true, compacted: false, reason: "everme: pending memory extraction flushed before compaction" };
    },

    async dispose({ sessionKey } = {}) {
      const sessionKeys = sessionKey ? [sessionKey] : Array.from(touched);
      if (sessionKeys.length) {
        let timer;
        try {
          await Promise.race([
            Promise.all(sessionKeys.map((key) => flushAgentMemory(client, { conversationId: key }, log))),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`flush timed out after ${DISPOSE_FLUSH_TIMEOUT_MS}ms`)),
                DISPOSE_FLUSH_TIMEOUT_MS,
              );
            }),
          ]);
        } catch (err) {
          log.warn(`${L} dispose flush failed: ${describeError(err)}`);
        } finally {
          clearTimeout(timer);
        }
      }
      // The cursor stays: the next run's engine continues the same session.
      if (sessionKey) touched.delete(sessionKey);
      else touched.clear();
    },
  };
}

function rememberUploaded(s, messages) {
  rememberKeys(s.uploaded, messages);
}

function rememberKeys(keys, messages) {
  for (const message of messages) keys.add(messageKey(message));
  // Set iteration is insertion order, so this drops the oldest keys.
  for (const key of keys) {
    if (keys.size <= UPLOADED_KEYS_MAX) break;
    keys.delete(key);
  }
}

// serialized runs fn after every earlier write of the session has settled,
// failed or not.
async function serialized(s, fn) {
  const previous = s.writing;
  let release;
  s.writing = new Promise((resolve) => { release = resolve; });
  try {
    await previous;
    return await fn();
  } finally {
    release();
  }
}

function rememberCommitted(ledgerKey) {
  commitAttempts.delete(ledgerKey);
  committedTurns.set(ledgerKey, Date.now());
  for (const key of committedTurns.keys()) {
    if (committedTurns.size <= COMMITTED_TURNS_MAX) break;
    committedTurns.delete(key);
  }
}

// messageKey identifies one canonical message across the two views of the
// same turn: afterTurn's in-memory snapshot and commitTurn's transcript read.
// Both carry the host's own timestamp, tool-call IDs and content.
function messageKey(message) {
  const content = Array.isArray(message.content)
    ? message.content.map((block) => block?.type === "toolCall"
      ? `call:${block.id}`
      : block?.type === "text" ? `text:${block.text ?? ""}` : `${block?.type}`).join("\u0001")
    : extractText(message.content);
  const digest = createHash("sha256").update(content).digest("hex").slice(0, 16);
  return [message.role, message.timestamp ?? "", message.toolCallId || message.tool_call_id || "", digest].join("|");
}

/** Test seam: forget every cross-engine cursor and ledger. */
export function resetSharedState() {
  sharedSessions.clear();
  committedTurns.clear();
  commitAttempts.clear();
}

// LobsterAI, a packaged OpenClaw, wraps each prompt in its session
// instructions (later prompts in a session open with "[Session info]"), with
// the user's words under "[Current user request]", and appends a local-time
// block. Text without those markers comes back as is.
const LOBSTERAI_HEADERS = ["[LobsterAI system instructions]", "[Session info]"];
const LOBSTERAI_REQUEST = "\n[Current user request]\n";
const LOBSTERAI_TIME_BLOCK = /\s*<!-- lobsterai:local-time-context:v\d+ -->[\s\S]*?<!-- \/lobsterai:local-time-context:v\d+ -->\s*$/;

function stripLobsterAIWrapper(text) {
  let out = String(text ?? "");
  if (LOBSTERAI_HEADERS.some((header) => out.trimStart().startsWith(header))) {
    const request = out.indexOf(LOBSTERAI_REQUEST);
    if (request >= 0) out = out.slice(request + LOBSTERAI_REQUEST.length);
  }
  return out.replace(LOBSTERAI_TIME_BLOCK, "");
}

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === AGENT_MEMORY_ROLES.USER) return messages[i];
  }
  return null;
}

function lastUserTurn(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === AGENT_MEMORY_ROLES.USER) return messages.slice(i);
  }
  return messages;
}

function canonicalTurnMessages(messages, log) {
  const out = [];
  let droppedCalls = 0;
  let droppedResults = 0;
  for (const message of messages) {
    if (message?.role === AGENT_MEMORY_ROLES.USER) {
      const content = stripLobsterAIWrapper(extractText(message.content)).trim();
      if (!content) continue;
      out.push({ ...message, content });
      continue;
    }
    if (message?.role === AGENT_MEMORY_ROLES.ASSISTANT && Array.isArray(message.content)) {
      const content = message.content.filter(block => {
        if (block?.type !== "toolCall" || hasNativeToolId(block.id)) return true;
        droppedCalls++;
        return false;
      });
      out.push({
        ...message,
        content,
        turnComplete: message.stopReason === "stop"
          && !message.content.some(block => block?.type === "toolCall")
          && message.content.some(block => block?.type === "text" && block.text?.trim()),
      });
      continue;
    }
    if ([AGENT_MEMORY_ROLES.TOOL, AGENT_MEMORY_ROLES.TOOL_RESULT].includes(message?.role)
      && !hasNativeToolId(message.toolCallId || message.tool_call_id)) {
      droppedResults++;
      continue;
    }
    if ([
      AGENT_MEMORY_ROLES.ASSISTANT,
      AGENT_MEMORY_ROLES.TOOL,
      AGENT_MEMORY_ROLES.TOOL_RESULT,
    ].includes(message?.role)) {
      out.push(message);
    }
  }
  if (droppedCalls || droppedResults) {
    log.warn?.(`[everme] openclaw parse dropped_invalid_call_id=${droppedCalls} dropped_invalid_result_id=${droppedResults}`);
  }
  return filterNativeToolContracts(out, log);
}

function hasNativeToolId(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function filterNativeToolContracts(messages, log) {
  const callCounts = new Map();
  const invalidCalls = new Set();
  const invalidIds = new Map();
  const dropped = {
    invalid_tool_name: { calls: 0, results: 0 },
    invalid_tool_arguments: { calls: 0, results: 0 },
  };
  for (const message of messages) {
    if (message.role !== AGENT_MEMORY_ROLES.ASSISTANT || !Array.isArray(message.content)) continue;
    for (const call of message.content) {
      if (call?.type !== "toolCall") continue;
      callCounts.set(call.id, (callCounts.get(call.id) || 0) + 1);
      const reason = invalidNativeToolCallReason(call);
      if (reason) {
        invalidCalls.add(call);
        invalidIds.set(call.id, reason);
        dropped[reason].calls++;
      }
    }
  }
  if (!invalidCalls.size) return messages;
  const filtered = [];
  for (const message of messages) {
    const id = message.toolCallId || message.tool_call_id;
    // Repeated source IDs cannot identify which call owns a result.
    if ([AGENT_MEMORY_ROLES.TOOL, AGENT_MEMORY_ROLES.TOOL_RESULT].includes(message.role)
      && invalidIds.has(id) && callCounts.get(id) === 1) {
      dropped[invalidIds.get(id)].results++;
      continue;
    }
    if (message.role === AGENT_MEMORY_ROLES.ASSISTANT && Array.isArray(message.content)) {
      filtered.push({ ...message, content: message.content.filter(block => !invalidCalls.has(block)) });
    } else {
      filtered.push(message);
    }
  }
  for (const [reason, counts] of Object.entries(dropped)) {
    if (counts.calls) log.warn?.(`[everme] openclaw parse reason=${reason} dropped_calls=${counts.calls} dropped_results=${counts.results}`);
  }
  return filtered;
}

function invalidNativeToolCallReason(call) {
  if (typeof call.name !== "string" || !call.name.trim()) return "invalid_tool_name";
  const args = call.arguments ?? call.input ?? {};
  if (typeof args === "string") {
    try {
      JSON.parse(args);
    } catch {
      return "invalid_tool_arguments";
    }
  }
  return "";
}

// trajectoryShape produces a compact "U:1/A:2(tc=1)/T:1" string for one
// log line — counts per role plus the number of assistant messages
// carrying tool_calls. Lets the operator tell at a glance whether the
// upstream host is feeding us a real tool round-trip vs a degenerate
// single-user-message turn (the bug pattern observed empirically in
// dev: 4 turns saved, 0 with tool_calls → 0 agent_case in EverOS).
function trajectoryShape(messages) {
  let u = 0, a = 0, t = 0, atc = 0;
  for (const m of messages) {
    if (!m || !m.role) continue;
    if (m.role === AGENT_MEMORY_ROLES.USER) u++;
    else if (m.role === AGENT_MEMORY_ROLES.ASSISTANT) {
      a++;
      if (Array.isArray(m.toolCalls) && m.toolCalls.length) atc++;
      else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b?.type === "tool_use" || b?.type === "toolCall") { atc++; break; }
        }
      }
    } else if (m.role === AGENT_MEMORY_ROLES.TOOL) t++;
  }
  return `U:${u}/A:${a}(tc=${atc})/T:${t}`;
}
