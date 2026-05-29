/**
 * OpenClaw ContextEngine adapter — bridges the OpenClaw lifecycle hooks
 * to the EverMe HTTP surface (search/context for read, realtime agent-memory
 * for write).
 *
 * Lifecycle compared to the reference EverOS plugin (plugin-local):
 *
 *   bootstrap   — assert config, init session state
 *   afterTurn   — write the raw turn through /mem/agent-memory
 *   assemble    — call getContext or searchMemory, render prompt
 *   compact     — no-op: EverMe is the source of truth, OpenClaw decides locally
 *   dispose     — drop in-memory cursors; afterTurn owns persistence
 *
 * Cold-start memory (the bulk of the user's history) is uploaded by
 * evercli `import run` BEFORE the agent ever starts. This plugin only
 * handles the live conversation turn-by-turn.
 */

import { randomUUID } from "node:crypto";

import {
  resolveConfig,
  assertConfigUsable,
  createClient,
  redactError,
  saveAgentMemory,
  searchMemory,
  toText,
  isSessionResetPrompt,
  buildMemoryPrompt,
  AGENT_MEMORY_ROLES,
} from "@everme/agent-sdk";

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2h, matches reference

export function createContextEngine(pluginMeta, hostConfig, hostLogger) {
  const log = hostLogger || { info() {}, warn() {} };
  const cfg = resolveConfig(hostConfig);
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

  // Per-session cursor + last-active timestamp for TTL pruning.
  const sessions = new Map(); // sessionKey → { lastActive, savedUpTo, turnCount }

  // pruneStale evicts inactive cursors only. It must not flush to
  // /mem/sources; OpenClaw runtime persistence is realtime-only.
  function pruneStale() {
    const now = Date.now();
    for (const [k, v] of sessions) {
      if (now - v.lastActive <= SESSION_TTL_MS) continue;
      sessions.delete(k);
      log.info?.(`${L} pruneStale: evicted session cursor ${k}`);
    }
  }

  function ensure(sessionKey) {
    let s = sessions.get(sessionKey);
    if (!s) {
      s = { lastActive: Date.now(), savedUpTo: 0, turnCount: 0 };
      sessions.set(sessionKey, s);
    } else {
      s.lastActive = Date.now();
    }
    return s;
  }

  return {
    info: {
      id: pluginMeta.id,
      name: pluginMeta.name,
      version: pluginMeta.version,
      ownsCompaction: false,
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

      const allMessages = messages || [];
      if (s.savedUpTo > allMessages.length) s.savedUpTo = 0;
      const sliceStart = prePromptMessageCount !== undefined
        ? Math.max(prePromptMessageCount, s.savedUpTo)
        : s.savedUpTo || 0;
      const tail = sliceStart > 0 ? allMessages.slice(sliceStart) : lastUserTurn(allMessages);
      if (!tail.length) return;

      if (cfg.flushEveryTurns === 0 && cfg.flushMaxBytes === 0) {
        s.turnCount += 1;
        s.savedUpTo = allMessages.length;
        return;
      }

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
      // gate on the post-increment value to flush on turn 1, N+1, 2N+1,
      // ... rather than 0-mod. flushEveryTurns=0 keeps the legacy
      // "never auto-flush" escape hatch.
      const nextTurn = s.turnCount + 1;
      const flush = cfg.flushEveryTurns > 0 && nextTurn % cfg.flushEveryTurns === 0;
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
        await saveAgentMemory(client, {
          conversationId: sessionKey,
          messages: tail,
          flush,
        }, log);
        s.turnCount = nextTurn;
        s.savedUpTo = allMessages.length;
        log.info?.(`${L} afterTurn[${engineId}]: saved ${tail.length} messages via agent-memory, sessionKey=${sessionKey} turn=${s.turnCount} flushed=${flush} shape=${shape}`);
      } catch (err) {
        // Leave turnCount/savedUpTo untouched so the same tail retries
        // on the next afterTurn — bumping them here would skip the
        // natural retry slot and could starve a flush turn if EverOS
        // keeps failing.
        log.warn(`${L} afterTurn realtime save failed: ${redactError(err?.message)}`);
      }
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
      if (sessionKey) ensure(sessionKey);

      const query = toText(prompt) || toText(lastUser(messages || [])?.content);
      if (!query || query.length < 3) return { messages, estimatedTokens: 0 };
      if (isSessionResetPrompt(query)) return { messages, estimatedTokens: 0 };

      try {
        const res = await searchMemory(
          client,
          { query, topK: cfg.topK },
          log,
        );
        const hasAny =
          res.memories?.length ||
          res.profiles?.length ||
          res.rawMessages?.length ||
          res.agentMemory?.cases?.length ||
          res.agentMemory?.skills?.length;
        if (!hasAny) return { messages, estimatedTokens: 0 };
        const block = buildMemoryPrompt(res, { wrapInCodeBlock: true });
        if (!block) return { messages, estimatedTokens: 0 };
        return {
          messages,
          estimatedTokens: Math.floor(block.length / 4),
          systemPromptAddition: block,
        };
      } catch (err) {
        log.warn(`${L} assemble /mem/search failed: ${redactError(err?.message)}`);
        return { messages, estimatedTokens: 0 };
      }
    },

    async compact({ sessionKey } = {}) {
      // We don't own compaction — host's compactor decides when. Runtime
      // writes are already handled in afterTurn via /mem/agent-memory.
      if (sessionKey) ensure(sessionKey);
      return { ok: true, compacted: false, reason: "everme: realtime memory writes are handled by afterTurn" };
    },

    async dispose({ sessionKey } = {}) {
      if (sessionKey) {
        sessions.delete(sessionKey);
      } else {
        // Whole-engine teardown.
        for (const [k] of sessions) {
          sessions.delete(k);
        }
      }
    },
  };
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
  return [];
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
