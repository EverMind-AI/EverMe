#!/usr/bin/env node

// ../agent-sdk/src/client.js
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

// ../agent-sdk/src/hooks/knobs.js
function resolveHookKnobs(env = process.env) {
  const flushMode = String(env.EVERME_FLUSH_MODE ?? "").trim().toLowerCase();
  const configuredFlushEveryTurns = strictInteger(
    env.EVERME_FLUSH_EVERY_TURNS,
    5,
    0,
    Number.MAX_SAFE_INTEGER
  );
  return {
    flushEveryTurns: flushMode === "legacy" ? 1 : configuredFlushEveryTurns,
    flushMode,
    injectTopK: strictInteger(env.EVERME_INJECT_TOPK, 10, 1, 20),
    injectProfile: strictBoolean(env.EVERME_INJECT_PROFILE, false),
    injectMinScore: strictFloat(env.EVERME_INJECT_MIN_SCORE, 0.1, 0, 1),
    telemetry: strictBoolean(env.EVERME_TELEMETRY, true)
  };
}
function strictInteger(value, fallback, min, max) {
  if (value === void 0 || value === null || value === "") return fallback;
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) return fallback;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
function strictFloat(value, fallback, min, max) {
  if (value === void 0 || value === null || value === "") return fallback;
  const text = String(value).trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return fallback;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
function strictBoolean(value, fallback) {
  if (value === void 0 || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false") return false;
  return fallback;
}

// ../agent-sdk/src/config.js
var DEFAULT_API_BASE = "https://api.everme.evermind.ai";
var API_PATH_PREFIX = "/api/v1";
var TIMEOUT_MS = 3e4;
function resolveConfig(host = {}) {
  const apiBase = trimSlash(host.apiBase || process.env.EVERME_API_BASE || DEFAULT_API_BASE);
  const hookKnobs = resolveHookKnobs({
    ...process.env,
    ...host.flushEveryTurns === void 0 ? {} : { EVERME_FLUSH_EVERY_TURNS: host.flushEveryTurns },
    ...host.flushMode === void 0 ? {} : { EVERME_FLUSH_MODE: host.flushMode },
    ...host.injectTopK === void 0 ? {} : { EVERME_INJECT_TOPK: host.injectTopK },
    ...host.injectProfile === void 0 ? {} : { EVERME_INJECT_PROFILE: host.injectProfile },
    ...host.injectMinScore === void 0 ? {} : { EVERME_INJECT_MIN_SCORE: host.injectMinScore }
  });
  return {
    // baseUrl always includes /api/v1 so callers don't have to think about it.
    // Idempotent — works whether the env var was set with or without the prefix.
    baseUrl: apiBase.endsWith(API_PATH_PREFIX) ? apiBase : apiBase + API_PATH_PREFIX,
    agentId: host.agentId === void 0 ? process.env.EVERME_AGENT_ID || "" : host.agentId,
    agentToken: host.agentToken === void 0 ? process.env.EVERME_AGENT_TOKEN || "" : host.agentToken,
    topK: host.topK ?? 10,
    ...hookKnobs,
    // Deprecated: retained for the existing both-zero compatibility switch.
    flushMaxBytes: host.flushMaxBytes ?? 64 * 1024
  };
}
function trimSlash(s) {
  return String(s || "").replace(/\/+$/, "");
}

// ../agent-sdk/src/hooks/deadline.js
var HOST_HOOK_TIMEOUT_S = Object.freeze({
  SessionStart: 30,
  UserPromptSubmit: 10,
  Stop: 30,
  SubagentStop: 30,
  SessionEnd: 30,
  PreCompact: 30
});
var HOOK_SAFETY_MARGIN_MS = 3e3;
var MIN_REQUEST_BUDGET_MS = 1e3;
function hookBudgetMs(event) {
  const seconds = HOST_HOOK_TIMEOUT_S[event];
  if (!seconds) return null;
  return seconds * 1e3 - HOOK_SAFETY_MARGIN_MS;
}
function boundedTimeoutMs(configuredMs, deadlineAt, now = Date.now()) {
  if (!deadlineAt) return configuredMs;
  const remaining = deadlineAt - now;
  if (remaining < MIN_REQUEST_BUDGET_MS) return MIN_REQUEST_BUDGET_MS;
  return Math.min(configuredMs, remaining);
}
function startHookWatchdog({
  event = "",
  budgetMs,
  onExpire,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  if (!budgetMs || budgetMs <= 0) return () => {
  };
  const fireAt = budgetMs + HOOK_SAFETY_MARGIN_MS / 2;
  const handle = setTimer(() => {
    onExpire?.(
      `EverMe ${event || "hook"} hook gave up after ${fireAt}ms to stay inside the host timeout`
    );
  }, fireAt);
  handle?.unref?.();
  return () => clearTimer(handle);
}

// ../agent-sdk/src/client.js
var noop = { info() {
}, warn() {
} };
var evtRe = /evt_[a-zA-Z0-9]{32}/g;
var emkRe = /emk_[a-zA-Z0-9]{32}/g;
var s3SigParamRe = /(X-Amz-Signature|X-Amz-Security-Token|X-Amz-Credential|x-amz-signature|x-amz-security-token|x-amz-credential)=[^&"\s]+/g;
var awsKeyIDRe = /A(?:SIA|KIA)[A-Z0-9]{16}/g;
function redactError(msg) {
  if (msg == null) return "";
  const text = msg instanceof Error ? msg.message : String(msg);
  return text.replace(evtRe, (m) => m.slice(0, 8) + "_REDACTED").replace(emkRe, (m) => m.slice(0, 8) + "_REDACTED").replace(s3SigParamRe, (_, name) => name + "=[REDACTED]").replace(awsKeyIDRe, "[REDACTED-AWSKEY]");
}
function boundedDiagnostic(value, maxChars = 240) {
  const text = redactError(value).replace(/\s+/g, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
var EvermeError = class extends Error {
  constructor({ message, status = 0, code = 0, requestId = "", type = "upstream" }) {
    super(boundedDiagnostic(message, 240));
    this.name = "EvermeError";
    this.httpStatus = status;
    this.code = code;
    this.requestId = boundedDiagnostic(requestId, 128);
    this.type = type;
  }
  /**
   * Support-friendly one-liner: message plus the errno and requestId a user
   * can quote to correlate with server-side logs. Every user-facing error
   * sink (MCP errResp, hook diagnostics, engine warns) should prefer this
   * over .message.
   */
  describe() {
    const parts = [];
    if (this.code) parts.push(`errno=${this.code}`);
    if (this.requestId) parts.push(`requestId=${this.requestId}`);
    return parts.length ? `${this.message} (${parts.join(", ")})` : this.message;
  }
};
function describeError(err) {
  if (err instanceof EvermeError) return err.describe();
  return boundedDiagnostic(err?.message || String(err), 240);
}
async function requestMeta(client, method, path4, body, opts) {
  if (typeof client?.requestWithMeta === "function") {
    return client.requestWithMeta(method, path4, body, opts);
  }
  return { result: await client.request(method, path4, body, opts), requestId: "" };
}
function createClient(cfg, log = noop) {
  const headers = (requestId) => ({
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${cfg.agentToken}`,
    "User-Agent": `everme-memory-mcp/0.1 (agentId=${cfg.agentId})`,
    // Client-generated trace id. The gateway reuses a valid inbound value,
    // so plugin logs, EverMe ELK, and the cloud platform all join on it —
    // even when the request times out before any response arrives.
    requestId
  });
  async function requestWithMeta(method, path4, body, { timeoutMs = TIMEOUT_MS, query } = {}) {
    const requestId = randomUUID();
    const url = buildUrl(cfg.baseUrl, path4, query);
    const init = {
      method,
      headers: headers(requestId),
      body: body == null ? void 0 : JSON.stringify(body)
    };
    return execWithRetry(url, init, boundedTimeoutMs(timeoutMs, cfg.deadlineAt), log, requestId);
  }
  async function request(method, path4, body, opts) {
    const { result } = await requestWithMeta(method, path4, body, opts);
    return result;
  }
  async function rawPost(uploadUrl, body, contentType, { timeoutMs = TIMEOUT_MS } = {}) {
    timeoutMs = boundedTimeoutMs(timeoutMs, cfg.deadlineAt);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const headers2 = contentType ? { "Content-Type": contentType } : void 0;
      let res;
      try {
        res = await fetch(uploadUrl, {
          method: "POST",
          body,
          headers: headers2,
          signal: ac.signal
        });
      } catch (err) {
        const aborted = ac.signal?.aborted;
        throw new EvermeError({
          message: redactError(
            aborted ? `S3 upload aborted after ${timeoutMs}ms` : `S3 upload transport error: ${err?.message || String(err)}`
          ),
          type: aborted ? "timeout" : "upstream"
        });
      }
      let text = "";
      let bodyReadFailed = false;
      try {
        text = await res.text();
      } catch (err) {
        bodyReadFailed = true;
        if (ac.signal?.aborted) {
          throw new EvermeError({
            message: redactError(`S3 upload aborted reading body after ${timeoutMs}ms`),
            type: "timeout"
          });
        }
        throw new EvermeError({
          message: redactError(`S3 upload body read failed: ${err?.message || String(err)}`),
          type: "upstream"
        });
      }
      if (!bodyReadFailed && res.status >= 200 && res.status < 300) return { ok: true };
      throw new EvermeError({
        message: redactError(
          `S3 upload rejected: HTTP ${res.status}${text ? " — " + text.slice(0, 200) : ""}`
        ),
        status: res.status,
        type: "upstream"
      });
    } finally {
      clearTimeout(t);
    }
  }
  return { request, requestWithMeta, rawPost };
}
function buildUrl(base, path4, query) {
  const qs = query ? new URLSearchParams() : null;
  if (qs) {
    for (const [k, v] of Object.entries(query)) {
      if (v == null || v === "") continue;
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
      else qs.set(k, String(v));
    }
  }
  const q = qs?.toString();
  return q ? `${base}${path4}?${q}` : `${base}${path4}`;
}
async function execWithRetry(url, init, timeoutMs, log, requestId) {
  try {
    return await execOnce(url, init, timeoutMs, requestId);
  } catch (err) {
    if (err instanceof EvermeError) {
      throw err;
    }
    const method = (init?.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      throw err;
    }
    log.warn?.(`[everme] ${method} failed, retrying once (requestId=${boundedDiagnostic(requestId, 128)}): ${boundedDiagnostic(err, 240)}`);
    await sleep(150);
    return execOnce(url, init, timeoutMs, requestId);
  }
}
async function execOnce(url, init, timeoutMs, requestId = "") {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  let text = "";
  try {
    try {
      res = await fetch(url, { ...init, signal: ac.signal });
    } catch (err) {
      const aborted = ac.signal.aborted;
      throw new EvermeError({
        message: aborted ? `timed out after ${timeoutMs}ms` : redactError(err?.message || String(err)),
        requestId,
        type: aborted ? "timeout" : "upstream"
      });
    }
    try {
      text = await res.text();
    } catch (err) {
      const aborted = ac.signal.aborted;
      throw new EvermeError({
        message: aborted ? `timed out reading body after ${timeoutMs}ms` : redactError(`body read failed: ${err?.message || String(err)}`),
        requestId,
        type: aborted ? "timeout" : "upstream"
      });
    }
  } finally {
    clearTimeout(t);
  }
  let env;
  try {
    env = text ? JSON.parse(text) : {};
  } catch {
    throw new EvermeError({
      message: `HTTP ${res.status}${text ? " — " + text.slice(0, 200) : ""}`,
      status: res.status,
      requestId: res.headers?.get?.("requestId") || requestId,
      type: res.status === 401 || res.status === 403 ? "auth" : "upstream"
    });
  }
  if (env && env.status === 0) {
    return { result: env.result ?? null, requestId: env.requestId || requestId };
  }
  const code = Number(env?.status) || 0;
  const errType = code >= 3e4 && code < 30300 && code !== 30104 ? "auth" : "upstream";
  throw new EvermeError({
    message: env?.error || `HTTP ${res.status}`,
    status: res.status,
    code,
    requestId: env?.requestId || requestId,
    type: errType
  });
}

// ../agent-sdk/src/messages.js
var METADATA_BLOCK_PATTERNS = [
  // "Conversation info / Sender (untrusted metadata):" + fenced block.
  // Fence language tag is optional (```json / ```JSON / plain ```).
  /(?:Conversation info|Sender|会话信息|发送者)\s*(?:\(untrusted metadata\))?\s*:\s*```[a-zA-Z]*\s*[\s\S]*?```/gi,
  // [message_id: xxx] optionally followed by a `key: value` line
  // (sender_id / from / etc.). Use horizontal whitespace after `]`
  // so the optional newline + key:value clause can still match;
  // \s* would greedily consume the newline.
  /\[message_id:\s*[^\]]*\][ \t]*(?:\r?\n\s*[\w.-]+\s*:\s*[^\r\n]*)?/gi
];
var LEADING_TIMESTAMP_PATTERN = /^\[(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+)?\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:\s+(?:GMT|UTC)[+-]\d+(?::\d{2})?|\s+[+-]\d{2}:?\d{2})?\]\s*/i;
function stripChannelMetadata(text) {
  if (!text) return text;
  let cleaned = text;
  for (const pattern of METADATA_BLOCK_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }
  cleaned = cleaned.trim().replace(LEADING_TIMESTAMP_PATTERN, "");
  return cleaned.trim();
}
function toText(content) {
  if (typeof content === "string") return stripChannelMetadata(content);
  if (Array.isArray(content)) {
    const joined = content.map((p) => typeof p === "string" ? p : p?.text || p?.content || "").filter(Boolean).join("\n");
    return stripChannelMetadata(joined);
  }
  if (content && typeof content === "object" && typeof content.text === "string") {
    return stripChannelMetadata(content.text);
  }
  return "";
}

// ../agent-sdk/src/truncate.js
var MAX_CONTENT_RUNES = 8e3;
var HEAD_RATIO = 0.7;
function capRunes(text, max = MAX_CONTENT_RUNES) {
  const s = typeof text === "string" ? text : String(text ?? "");
  if (max <= 0) return s;
  if (s.length <= max) return s;
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  const markerLen = `
[... trimmed ${cps.length} chars by everme import ...]
`.length;
  const budget = Math.max(0, max - markerLen);
  if (budget < 1) return cps.slice(0, max).join("");
  const head = Math.floor(budget * HEAD_RATIO);
  const tail = budget - head;
  const trimmed = cps.length - head - tail;
  const marker = `
[... trimmed ${trimmed} chars by everme import ...]
`;
  return cps.slice(0, head).join("") + marker + cps.slice(cps.length - tail).join("");
}

// ../agent-sdk/src/agent-memory.js
var AGENT_MEMORY_ROLES = Object.freeze({
  USER: "user",
  ASSISTANT: "assistant",
  TOOL: "tool",
  TOOL_RESULT: "toolResult"
});
var AGENT_MEMORY_TOOL_CALL_TYPES = Object.freeze({
  FUNCTION: "function"
});
var MAX_MESSAGES_PER_REQUEST = 500;
var LOG_ID_MAX_CHARS = 128;
var LOG_ERROR_MAX_CHARS = 240;
function logValue(value, maxChars = LOG_ID_MAX_CHARS) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
async function saveAgentMemory(client, { conversationId, messages = [], flush = true, channel, turns } = {}, log = { info() {
}, warn() {
} }) {
  if (!conversationId) {
    log.info?.("[everme] agent-memory stage=skip reason=missing_conversation_id");
    return null;
  }
  const flushOnly = flush === true && messages.length === 0;
  const stamp2 = Date.now();
  const converted = messages.map((m, i) => convertAgentMessage(m, stamp2 + i)).filter(Boolean).filter((m) => m.content != null || m.toolCalls && m.toolCalls.length);
  if (!converted.length && !flushOnly) {
    log.info?.(`[everme] agent-memory stage=skip reason=no_parseable_messages conversationId=${logValue(conversationId)} inputMessages=${messages.length}`);
    return null;
  }
  const batches = Math.max(1, Math.ceil(converted.length / MAX_MESSAGES_PER_REQUEST));
  if (batches > 1) {
    log.info?.(`[everme] agent-memory stage=start conversationId=${logValue(conversationId)} messages=${converted.length} batches=${batches} flush=${flush === true}`);
  }
  const declaredTurns = Number.isInteger(turns) && turns >= 0 ? turns : null;
  let res = null;
  const requestIds = [];
  for (let batch = 0; batch < batches; batch += 1) {
    const slice = converted.slice(batch * MAX_MESSAGES_PER_REQUEST, (batch + 1) * MAX_MESSAGES_PER_REQUEST);
    const isLast = batch === batches - 1;
    try {
      const { result, requestId } = await requestMeta(client, "POST", "/mem/agent-memory", {
        conversationId,
        messages: slice,
        flush: isLast ? flush : false,
        // Leading batches of a flushing upload must keep the server's
        // synchronous-add guarantee: an async leading batch can still be
        // invisible to the final request's flush (first-flush data loss,
        // one request boundary later). Servers without the field ignore it.
        ...!isLast && flush === true ? { sync: true } : {},
        ...channel ? { channel } : {},
        ...declaredTurns !== null && slice.length ? { turns: isLast ? declaredTurns : 0 } : {}
      });
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
async function flushAgentMemory(client, { conversationId } = {}, log) {
  return saveAgentMemory(client, { conversationId, messages: [], flush: true }, log);
}
function convertAgentMessage(msg, fallbackTimestamp) {
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
      content: cap(toText(msg.content))
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
        arguments: typeof args === "string" ? args : JSON.stringify(args)
      });
    }
  }
  if (Array.isArray(msg.toolCalls)) {
    for (const tc of msg.toolCalls) {
      if (!tc || !tc.id) continue;
      const args = tc.arguments ?? tc.input ?? "{}";
      toolCalls.push({
        id: tc.id,
        type: tc.type || AGENT_MEMORY_TOOL_CALL_TYPES.FUNCTION,
        name: tc.name ?? tc.function?.name ?? "unknown",
        arguments: typeof args === "string" ? args : JSON.stringify(args)
      });
    }
  }
  const content = cap(stripChannelMetadata(textParts.join("\n")));
  if (!content && !toolCalls.length) return null;
  return {
    role: AGENT_MEMORY_ROLES.ASSISTANT,
    timestamp,
    ...content ? { content } : {},
    ...toolCalls.length ? { toolCalls } : {}
  };
}
function normalizeTimestamp(ts, fallback) {
  if (typeof ts === "number" && Number.isFinite(ts)) {
    return ts > 1e10 ? Math.trunc(ts) : Math.trunc(ts * 1e3);
  }
  const parsed = Date.parse(ts);
  if (Number.isFinite(parsed)) return parsed;
  return fallback;
}
function cap(text) {
  return capRunes(text);
}

// ../agent-sdk/src/search.js
var noop2 = { info() {
}, warn() {
} };
var QUERY_MAX_CHARS = 1024;
async function searchMemory(client, params, log = noop2) {
  const body = {
    query: String(params.query || "").slice(0, QUERY_MAX_CHARS),
    topK: params.topK ?? 10,
    ...params.rankBy ? { rankBy: params.rankBy } : {},
    ...params.filter ? { filter: params.filter } : {},
    ...Array.isArray(params.memoryTypes) && params.memoryTypes.length ? { memoryTypes: params.memoryTypes } : {}
  };
  const { result: res, requestId } = await requestMeta(client, "POST", "/mem/search", body);
  const memoryCount = Array.isArray(res?.items) ? res.items.length : 0;
  const profileCount = Array.isArray(res?.profiles) ? res.profiles.length : 0;
  const rawMessageCount = Array.isArray(res?.rawMessages) ? res.rawMessages.length : 0;
  const caseCount = Array.isArray(res?.agentMemory?.cases) ? res.agentMemory.cases.length : 0;
  const skillCount = Array.isArray(res?.agentMemory?.skills) ? res.agentMemory.skills.length : 0;
  log.info?.(`[everme] memory-search stage=complete result=success queryChars=${body.query.length} topK=${body.topK} memories=${memoryCount} profiles=${profileCount} rawMessages=${rawMessageCount} cases=${caseCount} skills=${skillCount} requestId=${boundedDiagnostic(requestId, 128)}`);
  return {
    memories: res?.items ?? [],
    profiles: res?.profiles ?? [],
    rawMessages: res?.rawMessages ?? [],
    agentMemory: res?.agentMemory ?? { cases: [], skills: [] },
    requestId
  };
}

// ../agent-sdk/src/prompt.js
var MEMORY_TYPES = Object.freeze({
  EPISODIC: "episodic",
  EPISODIC_MEMORY: "episodic_memory",
  PROFILE: "profile",
  AGENT_MEMORY: "agent_memory",
  RAW_MESSAGE: "raw_message"
});
var MEMORY_TYPE_LABELS = Object.freeze({
  [MEMORY_TYPES.EPISODIC]: "episodic",
  [MEMORY_TYPES.EPISODIC_MEMORY]: "episodic",
  [MEMORY_TYPES.PROFILE]: "profile",
  [MEMORY_TYPES.AGENT_MEMORY]: "agent",
  [MEMORY_TYPES.RAW_MESSAGE]: "recent"
});
function buildMemoryPrompt(memoriesOrBundle, { wrapInCodeBlock = false, sections: requestedSections } = {}) {
  const bundle = Array.isArray(memoriesOrBundle) ? { memories: memoriesOrBundle } : memoriesOrBundle || {};
  const enabled = {
    episodes: true,
    profiles: true,
    skills: true,
    cases: true,
    rawMessages: true,
    ...requestedSections
  };
  const sections = [];
  const episodes = (bundle.memories || []).map(formatRow).filter(Boolean);
  if (enabled.episodes && episodes.length) sections.push(["### Episodic memory", ...episodes].join("\n"));
  const profiles = (bundle.profiles || []).map(formatProfile).filter(Boolean);
  if (enabled.profiles && profiles.length) sections.push(["### User profile", ...profiles].join("\n"));
  const skills = (bundle.agentMemory?.skills || []).map(formatSkill).filter(Boolean);
  if (enabled.skills && skills.length) sections.push(["### Agent skills", ...skills].join("\n"));
  const cases = (bundle.agentMemory?.cases || []).map(formatCase).filter(Boolean);
  if (enabled.cases && cases.length) sections.push(["### Past task cases", ...cases].join("\n"));
  const raw = (bundle.rawMessages || []).map(formatRawMessage).filter(Boolean);
  if (enabled.rawMessages && raw.length) sections.push(["### Recent unextracted transcript — provisional, not a stable memory", ...raw].join("\n"));
  if (!sections.length) return "";
  const body = ["## Relevant memory", ...sections].join("\n\n");
  return wrapInCodeBlock ? "```memory\n" + body + "\n```" : body;
}
function formatRow(m) {
  if (!m) return "";
  const label = MEMORY_TYPE_LABELS[m.type] || m.type || "memory";
  const text = m.episode || m.summary || m.content || m.text || "";
  if (!text) return "";
  return `- [${label}] ${oneLine(text)}`;
}
function formatProfile(p) {
  if (!p) return "";
  const data = p.profileData || {};
  const text = data.embed_text || p.summary || "";
  if (!text) return "";
  const tag = data.item_type || "profile";
  return `- [${tag}] ${oneLine(text)}`;
}
function formatSkill(s) {
  if (!s) return "";
  const name = s.name || "(unnamed skill)";
  const desc = s.description || s.content || "";
  const head = `- [skill] ${name}`;
  return desc ? `${head} — ${oneLine(desc)}` : head;
}
function formatCase(c) {
  if (!c) return "";
  const intent = c.taskIntent || "";
  const approach = c.approach || "";
  if (!intent && !approach) return "";
  const head = intent ? `- [case] ${oneLine(intent)}` : "- [case]";
  return approach ? `${head} — ${oneLine(approach)}` : head;
}
function formatRawMessage(m) {
  if (!m) return "";
  const sender = m.senderName || "speaker";
  const text = rawMessageText(m.contentItems);
  if (!text) return "";
  return `- [raw ${sender}] ${oneLine(text)}`;
}
function rawMessageText(parts) {
  if (!Array.isArray(parts)) return "";
  const chunks = [];
  for (const p of parts) {
    if (!p) continue;
    if (typeof p === "string") {
      chunks.push(p);
      continue;
    }
    if (typeof p.text === "string") {
      chunks.push(p.text);
      continue;
    }
    if (typeof p.content === "string") {
      chunks.push(p.content);
    }
  }
  return chunks.join(" ");
}
function oneLine(s) {
  return String(s).replace(/\s+/g, " ").trim().slice(0, 280);
}

// ../agent-sdk/src/hooks/query.js
var FOLD_MARKER = "[...]";
var MAX_PASTE_RUN_CHARS = 400;
var STRIP_RULES = [
  // Host reminder / context blocks. Claude Code, MiniMax Code and others wrap
  // injected guidance in these; MiniMax delivers them inside the prompt field
  // itself, so without this the reminder IS the query.
  ["reminder", /<system-reminder>[\s\S]*?<\/system-reminder>/gi],
  ["reminder", /<system_reminder>[\s\S]*?<\/system_reminder>/gi],
  // IDE panes: current selection / opened file context.
  ["ide", /<ide_selection>[\s\S]*?<\/ide_selection>/gi],
  ["ide", /<ide_opened_file>[\s\S]*?<\/ide_opened_file>/gi],
  // Expanded slash commands. The host replaces "/cmd args" with this XML, so
  // the leading-slash rule below can no longer see it.
  ["command", /<command-(?:name|message|args)>[\s\S]*?<\/command-(?:name|message|args)>/gi],
  // Our own injections coming back around. A host that echoes the previous
  // turn's user message would otherwise feed our memory block back in as the
  // next query, making recall search its own output.
  ["everme", /<everme_[a-z_]+>[\s\S]*?<\/everme_[a-z_]+>/gi],
  // No /m here: with it, `$` would match end-of-LINE and the block would stop
  // at its own heading, leaving the memory body in the query.
  ["everme", /(?:^|\n)#{1,3}[ \t]*EverMe Memory\b[\s\S]*?(?=\n[ \t]*\n|\n#{1,3}[ \t]|$)/gi],
  // Local-command caveat preamble (prepended to prompts that followed a bash
  // invocation).
  ["caveat", /^[ \t]*Caveat:[ \t]*The messages below were generated by the user while running local commands.*$/gim],
  // Attachment / tool-output envelopes some hosts inline.
  ["attachment", /<(?:attachment|tool_result|function_results)>[\s\S]*?<\/(?:attachment|tool_result|function_results)>/gi]
];
var LEADING_COMMAND_RE = /^\s*\/[^\s]+(?:\s+|$)/u;
var FENCED_CODE_RE = /```[\s\S]*?(?:```|$)/g;
var LONG_RUN_RE = /\S{400,}/gu;
function extractUserIntent(text) {
  const raw = String(text ?? "");
  const removed = {};
  let working = raw;
  const drop = (name, next) => {
    const delta = working.length - next.length;
    if (delta > 0) removed[name] = (removed[name] || 0) + delta;
    working = next;
  };
  for (const [name, pattern] of STRIP_RULES) {
    drop(name, working.replace(pattern, " "));
  }
  drop("code", working.replace(FENCED_CODE_RE, ` ${FOLD_MARKER} `));
  drop("command", working.replace(LEADING_COMMAND_RE, ""));
  drop("paste", working.replace(LONG_RUN_RE, (run) => `${run.slice(0, MAX_PASTE_RUN_CHARS)} ${FOLD_MARKER}`));
  working = working.replace(/\s+/gu, " ").trim();
  let clamped = false;
  if (working.length > QUERY_MAX_CHARS) {
    const tail = working.slice(working.length - QUERY_MAX_CHARS);
    const boundary = tail.search(/\s/);
    working = (boundary > 0 && boundary < 80 ? tail.slice(boundary + 1) : tail).trim();
    clamped = true;
  }
  return {
    query: working,
    stats: { rawChars: raw.length, queryChars: working.length, removed, clamped }
  };
}
function formatQueryStats(stats) {
  const removed = Object.entries(stats?.removed || {}).sort(([, a], [, b]) => b - a).map(([name, chars]) => `${name}:${chars}`).join(",");
  return `raw=${stats?.rawChars ?? 0} query=${stats?.queryChars ?? 0} clamped=${Boolean(stats?.clamped)} removed{${removed}}`;
}

// ../agent-sdk/src/hooks/state.js
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
var DEFAULT_STATE_DIR = path.join(os.homedir(), ".everme", "state");
var STATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1e3;
function createSessionState({ stateDir = DEFAULT_STATE_DIR } = {}) {
  const fileFor = (sessionId) => path.join(stateDir, `${sanitizeSessionId(sessionId)}.json`);
  return {
    read(sessionId) {
      return readState(fileFor(sessionId));
    },
    async patch(sessionId, patch) {
      await mkdir(stateDir, { recursive: true, mode: 448 });
      const file = fileFor(sessionId);
      const next = { ...await readState(file), ...patch };
      await writeState(file, next);
      await pruneStaleStateFiles(stateDir, file);
      return next;
    }
  };
}
function createTurnCounter({ stateDir = DEFAULT_STATE_DIR } = {}) {
  const store = createSessionState({ stateDir });
  return {
    async peek(sessionId, turnId) {
      const current = await store.read(sessionId);
      if (turnId && current.lastTurnId === turnId) {
        return { count: current.count, duplicate: true };
      }
      return { count: current.count + 1, duplicate: false };
    },
    // `extra` rides along on the same write so clearing the delivery marker
    // on a committed turn costs no second file write.
    async commit(sessionId, turnId, extra = {}) {
      const current = await store.read(sessionId);
      const next = await store.patch(sessionId, {
        count: current.count + 1,
        lastTurnId: turnId || "",
        ...extra
      });
      return { count: next.count, duplicate: false };
    }
  };
}
function createTranscriptCheckpointStore({ stateDir = DEFAULT_STATE_DIR } = {}) {
  const fileFor = (stateId) => path.join(stateDir, `${sanitizeSessionId(stateId)}.transcript.json`);
  return {
    async read(stateId) {
      try {
        const parsed = JSON.parse(await readFile(fileFor(stateId), "utf8"));
        return {
          initialized: parsed.initialized === true,
          uploadedCount: nonNegativeInteger(parsed.uploadedCount)
        };
      } catch (error) {
        if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        return { initialized: false, uploadedCount: 0 };
      }
    },
    async commit(stateId, uploadedCount) {
      await mkdir(stateDir, { recursive: true, mode: 448 });
      const file = fileFor(stateId);
      const next = { initialized: true, uploadedCount: nonNegativeInteger(uploadedCount) };
      await writeState(file, next);
      await pruneStaleStateFiles(stateDir, file);
      return next;
    }
  };
}
async function readState(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return {
      count: nonNegativeInteger(parsed.count),
      lastTurnId: typeof parsed.lastTurnId === "string" ? parsed.lastTurnId : "",
      uploadedCount: nonNegativeInteger(parsed.uploadedCount),
      pendingTurn: pendingTurn(parsed.pendingTurn),
      lostTurns: nonNegativeInteger(parsed.lostTurns)
    };
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return { count: 0, lastTurnId: "", uploadedCount: 0, pendingTurn: null, lostTurns: 0 };
  }
}
function pendingTurn(value) {
  if (!value || typeof value !== "object") return null;
  const startedAt = nonNegativeInteger(value.startedAt);
  if (!startedAt) return null;
  return { startedAt, turnId: typeof value.turnId === "string" ? value.turnId : "" };
}
function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
async function writeState(file, state) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(state), { encoding: "utf8", mode: 384, flag: "wx" });
    await rename(temp, file);
    await chmod(file, 384);
  } catch (error) {
    await unlink(temp).catch(() => {
    });
    throw error;
  }
}
async function pruneStaleStateFiles(stateDir, keepFile) {
  try {
    const cutoff = Date.now() - STATE_MAX_AGE_MS;
    for (const name of await readdir(stateDir)) {
      if (!name.endsWith(".json") && !name.endsWith(".toolbuf.jsonl")) continue;
      const file = path.join(stateDir, name);
      if (file === keepFile) continue;
      try {
        const info = await stat(file);
        if (info.mtimeMs < cutoff) await unlink(file);
      } catch {
      }
    }
  } catch {
  }
}
function sanitizeSessionId(sessionId) {
  const sanitized = String(sessionId || "default").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 120);
  return sanitized || "default";
}

// ../agent-sdk/src/hooks/telemetry.js
var TELEMETRY_PATH = "/mem/import-events";
var TELEMETRY_TIMEOUT_MS = 2e3;
var MIN_TELEMETRY_BUDGET_MS = 1500;
function turnDeliveryEvent({ outcome, code = "" }) {
  return { event: "turn_delivery", channel: "hooks", outcome, ...code ? { code } : {} };
}
function hookDegradedEvent({ hookEvent, code = "" }) {
  return { event: "hook_degraded", channel: "hooks", hookEvent, ...code ? { code } : {} };
}
function degradedCode(error) {
  if (error?.name === "EvermeError") {
    return String(error.code || error.type || "upstream").slice(0, 64);
  }
  return String(error?.code || error?.name || "error").slice(0, 64);
}
function telemetryTimeoutMs(deadlineAt, now = Date.now()) {
  if (!deadlineAt) return TELEMETRY_TIMEOUT_MS;
  const remaining = deadlineAt - now;
  if (remaining < MIN_TELEMETRY_BUDGET_MS) return 0;
  return Math.min(TELEMETRY_TIMEOUT_MS, remaining);
}
function createTelemetry({ client, config = {}, now = Date.now } = {}) {
  const enabled = Boolean(client) && config.telemetry !== false;
  return {
    enabled,
    async report(event) {
      if (!enabled || !event) return false;
      const timeoutMs = telemetryTimeoutMs(config.deadlineAt, now());
      if (!timeoutMs) return false;
      try {
        await requestMeta(client, "POST", TELEMETRY_PATH, { ...event, ts: now() }, { timeoutMs });
        return true;
      } catch {
        return false;
      }
    }
  };
}

// ../agent-sdk/src/hooks/runtime.js
import { readFile as readFile2 } from "node:fs/promises";

// ../agent-sdk/src/hooks/inject.js
var MIN_PROMPT_TOKENS = 3;
async function runInject({ input, client, config, search = searchMemory, log }) {
  const { query, stats } = extractUserIntent(input?.prompt);
  writeQueryStats(log, stats);
  if (countTokens(query) < MIN_PROMPT_TOKENS) return { block: "", count: 0 };
  const result = await search(client, { query, topK: config.injectTopK }, log);
  const memories = (result?.memories || []).filter((memory) => {
    const score = memory?.score ?? memory?.relevanceScore;
    return score == null || score === 0 || score >= config.injectMinScore;
  });
  const bundle = {
    memories,
    profiles: result?.profiles || [],
    rawMessages: result?.rawMessages || [],
    agentMemory: result?.agentMemory || { cases: [], skills: [] }
  };
  const sections = {
    episodes: true,
    profiles: config.injectProfile,
    skills: true,
    cases: true,
    rawMessages: true
  };
  const inner = buildMemoryPrompt(bundle, { sections });
  if (!inner) return { block: "", count: 0 };
  return {
    block: `<everme_recall>
${inner}
</everme_recall>`,
    count: countBundle(bundle, sections)
  };
}
function writeQueryStats(log, stats) {
  const line = `[everme] recall query: ${formatQueryStats(stats)}`;
  if (typeof log?.info === "function") {
    log.info(line);
    return;
  }
  try {
    process.stderr.write(`${line}
`);
  } catch {
  }
}
function countTokens(text) {
  if (!text) return 0;
  const cjkPattern = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;
  const cjkCount = (text.match(cjkPattern) || []).length;
  const otherCount = text.replace(cjkPattern, " ").split(/\s+/).filter(Boolean).length;
  return cjkCount + otherCount;
}
function countBundle(bundle, sections) {
  return (sections.episodes ? bundle.memories.length : 0) + (sections.profiles ? bundle.profiles.length : 0) + (sections.skills ? bundle.agentMemory?.skills?.length || 0 : 0) + (sections.cases ? bundle.agentMemory?.cases?.length || 0 : 0) + (sections.rawMessages ? bundle.rawMessages.length : 0);
}

// ../agent-sdk/src/hooks/session-start.js
async function runSessionStart({ client, log }) {
  const { result, requestId } = await requestMeta(client, "POST", "/mem/context", {});
  const profile = result?.profile;
  const count = profileItemCount(profile);
  log?.info?.(`[everme] memory-context stage=complete result=success items=${count} requestId=${boundedDiagnostic(requestId, 128)}`);
  return {
    block: renderProfileBlock(profile),
    count,
    requestId
  };
}
function renderProfileBlock(profile) {
  if (!profile) return "";
  const explicit = Array.isArray(profile.explicit_info) ? profile.explicit_info : [];
  const implicit = Array.isArray(profile.implicit_traits) ? profile.implicit_traits : [];
  if (!explicit.length && !implicit.length) return "";
  const lines = ["<everme_profile>"];
  if (explicit.length) {
    lines.push("Profile facts:");
    for (const item of explicit.slice(0, 12)) {
      const description = item?.description || item?.evidence || "";
      if (!description) continue;
      const category = item.category ? `[${item.category}] ` : "";
      lines.push(`- ${category}${truncate(description, 240)}`);
    }
  }
  if (implicit.length) {
    lines.push("Implicit traits:");
    for (const item of implicit.slice(0, 6)) {
      const name = item?.trait || item?.name || "trait";
      lines.push(`- ${name}: ${truncate(item?.description || "", 200)}`);
    }
  }
  lines.push("</everme_profile>");
  return lines.join("\n");
}
function profileItemCount(profile) {
  if (!profile) return 0;
  return (Array.isArray(profile.explicit_info) ? profile.explicit_info.length : 0) + (Array.isArray(profile.implicit_traits) ? profile.implicit_traits.length : 0);
}
function truncate(value, maxLength) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

// ../agent-sdk/src/hooks/runtime-core.js
function createHookRuntime({ enqueue, flush, diagnostic = () => {
}, rethrowOnError = false } = {}) {
  if (typeof enqueue !== "function") throw new TypeError("hook-runtime requires enqueue");
  if (typeof flush !== "function") throw new TypeError("hook-runtime requires flush");
  async function safe(label, operation) {
    try {
      return await operation();
    } catch (error) {
      try {
        diagnostic(`EverMe ${label} degraded: ${describeError(error)}`);
      } catch {
      }
      if (rethrowOnError) throw error;
      return void 0;
    }
  }
  return {
    enqueueTurn(turn) {
      return safe("turn enqueue", () => enqueue({ ...turn, flush: false }));
    },
    onStop(conversationId) {
      return safe("Stop flush", () => flush(conversationId));
    },
    onSessionEnd(conversationId) {
      return safe("SessionEnd flush", () => flush(conversationId));
    },
    flushSession(turn) {
      return safe("session flush", () => enqueue({ ...turn, flush: true }));
    },
    flush(conversationId) {
      return safe("boundary flush", () => flush(conversationId));
    }
  };
}

// ../agent-sdk/src/hooks/store.js
async function runStore({
  input,
  adapter,
  client,
  config,
  counter,
  checkpointStore,
  sessionState,
  stateDir,
  log,
  diagnostic,
  telemetry
}) {
  const sessionId = input?.sessionId;
  if (!sessionId) {
    log.info?.("[everme] store stage=skip reason=missing_session_id");
    return { block: "", count: 0 };
  }
  const previous = sessionState ? await sessionState.read(sessionId) : {};
  const pending = previous.pendingTurn ?? null;
  const telemetryOn = Boolean(telemetry?.enabled);
  const carried = telemetryOn ? normalizeDebt(previous.lostTurns) : 0;
  const provisionalDebt = telemetryOn && pending ? carried + 1 : carried;
  const provisionalTurnId = input?.turnId || "";
  await markInFlight(sessionState, sessionId, provisionalTurnId, provisionalDebt);
  const turnId = await resolveTurnId(adapter, input);
  const retryOfPending = Boolean(pending && pending.turnId && pending.turnId === turnId);
  const owed = await payDownLosses(telemetry, retryOfPending ? provisionalDebt - 1 : provisionalDebt);
  if (turnId !== provisionalTurnId || owed !== provisionalDebt) {
    await markInFlight(sessionState, sessionId, turnId, owed);
  }
  if (typeof adapter.readStoreBatches === "function") {
    const batches = await adapter.readStoreBatches(input, { checkpointStore, stateDir });
    if (Array.isArray(batches)) {
      return runStoreBatches({
        batches,
        input,
        adapter,
        client,
        config,
        counter,
        checkpointStore,
        sessionState,
        log,
        diagnostic,
        telemetry,
        retryOfPending,
        turnId
      });
    }
  }
  const messages = await adapter.readLastTurn(input, { stateDir });
  if (!Array.isArray(messages) || !messages.length) {
    log.info?.(`[everme] store stage=skip reason=no_messages sessionId=${logId(sessionId)}`);
    await clearMarker(sessionState, sessionId);
    return { block: "", count: 0 };
  }
  const state = await counter.peek(sessionId, turnId);
  if (state.duplicate) {
    log.info?.(`[everme] store stage=skip reason=duplicate sessionId=${logId(sessionId)} turnId=${logId(turnId)}`);
    await clearMarker(sessionState, sessionId);
    return { block: "", count: 0, duplicate: true };
  }
  const runtime = createHookRuntime({
    // One Stop = one logical turn: claim the hook channel and declare it, so
    // the gateway's write counter (L1-2's denominator) stays in turns even
    // when a long turn is split into several requests.
    enqueue: (turn) => saveAgentMemory(client, { ...turn, channel: "hook", turns: 1 }, log),
    flush: (conversationId) => flushAgentMemory(client, { conversationId }, log),
    diagnostic,
    rethrowOnError: true
  });
  if (config.flushMode === "legacy") {
    const saved2 = await runtime.flushSession({ conversationId: sessionId, messages });
    await counter.commit(sessionId, turnId, { pendingTurn: null });
    await reportRecovery(telemetry, retryOfPending);
    return { block: "", count: messages.length, flushed: true, status: saved2?.status, requestId: saved2?.requestId };
  }
  const saved = await runtime.enqueueTurn({ conversationId: sessionId, messages });
  const committed = await counter.commit(sessionId, turnId, { pendingTurn: null });
  await reportRecovery(telemetry, retryOfPending);
  const flushed = config.flushEveryTurns > 0 && committed.count % config.flushEveryTurns === 0;
  let requestId = saved?.requestId;
  if (flushed) {
    const flushRes = await runtime.flush(sessionId);
    requestId = flushRes?.requestId || requestId;
  }
  return { block: "", count: messages.length, flushed, requestId };
}
async function runStoreBatches({
  batches,
  input,
  adapter,
  client,
  config,
  counter,
  checkpointStore,
  sessionState,
  log,
  diagnostic,
  telemetry,
  retryOfPending,
  turnId
}) {
  const ready = batches.filter((batch) => batch && typeof batch.conversationId === "string" && batch.conversationId && Array.isArray(batch.messages) && batch.messages.length);
  if (!ready.length) {
    log.info?.(`[everme] store stage=skip reason=no_ready_batches sessionId=${logId(input?.sessionId)} inputBatches=${Array.isArray(batches) ? batches.length : 0}`);
    await clearMarker(sessionState, input?.sessionId);
    return { block: "", count: 0 };
  }
  const turn = await counter.peek(input.sessionId, turnId);
  const runtime = createHookRuntime({
    enqueue: (batch) => saveAgentMemory(client, batch, log),
    flush: (conversationId) => flushAgentMemory(client, { conversationId }, log),
    diagnostic,
    rethrowOnError: true
  });
  let requestId;
  let status;
  let count = 0;
  for (const batch of ready) {
    const saved = config.flushMode === "legacy" ? await runtime.flushSession(batch) : await runtime.enqueueTurn(batch);
    requestId = saved?.requestId || requestId;
    status = saved?.status || status;
    count += batch.messages.length;
    if (batch.checkpoint && checkpointStore) {
      await checkpointStore.commit(batch.checkpoint.stateId, batch.checkpoint.uploadedCount);
    }
  }
  let committed = { count: turn.count };
  if (turn.duplicate) {
    await clearMarker(sessionState, input.sessionId);
  } else {
    committed = await counter.commit(input.sessionId, turnId, { pendingTurn: null });
  }
  await reportRecovery(telemetry, retryOfPending);
  if (config.flushMode === "legacy") {
    return { block: "", count, flushed: true, status, requestId };
  }
  const flushed = config.flushEveryTurns > 0 && committed.count % config.flushEveryTurns === 0;
  if (flushed) {
    for (const conversationId of new Set(ready.map((batch) => batch.conversationId))) {
      const flushRes = await runtime.flush(conversationId);
      requestId = flushRes?.requestId || requestId;
    }
  }
  return { block: "", count, flushed, requestId };
}
async function reportRecovery(telemetry, retryOfPending) {
  if (!retryOfPending) return;
  await telemetry?.report(turnDeliveryEvent({ outcome: "recovered" }));
}
async function payDownLosses(telemetry, owed) {
  if (owed <= 0) return 0;
  if (await telemetry?.report(turnDeliveryEvent({ outcome: "lost_prev" }))) return owed - 1;
  return owed;
}
function normalizeDebt(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}
async function markInFlight(sessionState, sessionId, turnId, lostTurns) {
  if (!sessionState) return;
  await sessionState.patch(sessionId, {
    pendingTurn: { startedAt: Date.now(), turnId },
    lostTurns: normalizeDebt(lostTurns)
  });
}
async function clearMarker(sessionState, sessionId) {
  if (!sessionState) return;
  await sessionState.patch(sessionId, { pendingTurn: null });
}
async function resolveTurnId(adapter, input) {
  if (input?.turnId) return input.turnId;
  if (typeof adapter?.resolveTurnId !== "function") return "";
  return await adapter.resolveTurnId(input) || "";
}
function logId(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 128 ? `${text.slice(0, 128)}…` : text;
}
async function runBoundaryFlush({
  input,
  adapter,
  client,
  sessionState,
  checkpointStore,
  stateDir,
  log,
  diagnostic
}) {
  if (!input?.sessionId) return { block: "", count: 0 };
  const runtime = createHookRuntime({
    enqueue: (turn) => saveAgentMemory(client, turn, log),
    flush: (conversationId) => flushAgentMemory(client, { conversationId }, log),
    diagnostic,
    rethrowOnError: true
  });
  if (typeof adapter?.readSessionBatches === "function") {
    const batches = await adapter.readSessionBatches(input, { checkpointStore, stateDir });
    if (Array.isArray(batches)) {
      const ready = batches.filter((batch) => batch && typeof batch.conversationId === "string" && batch.conversationId && Array.isArray(batch.messages) && batch.messages.length);
      if (!ready.length) return { block: "", count: 0, skipped: true };
      let count = 0;
      let requestId;
      for (const batch of ready) {
        const saved = await runtime.flushSession(batch);
        requestId = saved?.requestId || requestId;
        count += batch.messages.length;
        if (batch.checkpoint && checkpointStore) {
          await checkpointStore.commit(batch.checkpoint.stateId, batch.checkpoint.uploadedCount);
        }
      }
      return { block: "", count, flushed: true, requestId };
    }
  }
  if (typeof adapter?.readSession === "function") {
    const messages = await adapter.readSession(input);
    if (!Array.isArray(messages) || !messages.length) return { block: "", count: 0 };
    const uploadedCount = sessionState ? (await sessionState.read(input.sessionId)).uploadedCount : 0;
    const delta = uploadedCount > 0 ? messages.slice(uploadedCount) : messages;
    if (!delta.length) return { block: "", count: 0, skipped: true };
    const saved = adapter?.boundaryFlush === false ? await runtime.enqueueTurn({ conversationId: input.sessionId, messages: delta }) : await runtime.flushSession({ conversationId: input.sessionId, messages: delta });
    if (sessionState) await sessionState.patch(input.sessionId, { uploadedCount: messages.length });
    return {
      block: "",
      count: delta.length,
      flushed: adapter?.boundaryFlush !== false,
      status: saved?.status,
      requestId: saved?.requestId
    };
  }
  const flushRes = await runtime.onSessionEnd(input.sessionId);
  return { block: "", count: 0, flushed: true, requestId: flushRes?.requestId };
}

// ../agent-sdk/src/hooks/runtime.js
var WRITE_EVENTS = /* @__PURE__ */ new Set(["Stop", "SubagentStop", "SessionEnd", "PreCompact", "PostToolUse"]);
var ROTATED_KEYS = /* @__PURE__ */ new Set(["EVERME_AGENT_TOKEN", "EVERME_AGENT_ID"]);
async function runHook(event, rawInput, adapter, deps = {}) {
  const stopWatchdog = startHookWatchdog({
    event: adapter?.mapEvent?.(event) || event,
    budgetMs: hookBudgetMs(adapter?.mapEvent?.(event) || event),
    onExpire: (line) => {
      try {
        process.stderr.write(`${line}
`);
      } catch {
      }
      process.exit(0);
    }
  });
  try {
    return await runHostHook(event, rawInput, adapter, {
      ...deps,
      resolveConfig: resolveRuntimeConfig,
      createClient,
      createTurnCounter,
      createSessionState,
      createTranscriptCheckpointStore,
      createTelemetry,
      runSessionStart,
      runInject,
      runStore,
      runBoundaryFlush,
      redactError
    });
  } finally {
    stopWatchdog();
  }
}
var stderrLog = {
  info(line) {
    try {
      process.stderr.write(`${line}
`);
    } catch {
    }
  },
  warn(line) {
    this.info(line);
  }
};
async function runHostHook(event, rawInput, adapter, deps = {}) {
  const hostEvent = event;
  let result = { block: "", count: 0 };
  let telemetry = null;
  let degradedEvent = hostEvent;
  try {
    const canonicalEvent = adapter.mapEvent?.(hostEvent) || hostEvent;
    degradedEvent = canonicalEvent;
    const input = await adapter.normalizeInput(rawInput || {}, hostEvent);
    const env = deps.env || await loadRuntimeEnv(adapter, deps.baseEnv || process.env);
    const baseConfig = deps.config || requireOperation(deps.resolveConfig, "resolveConfig")(env);
    if (!baseConfig.isConfigured) return formatOutput(adapter, hostEvent, result);
    if (WRITE_EVENTS.has(canonicalEvent) && (baseConfig.authMode !== "evt" || !baseConfig.agentId)) {
      return formatOutput(adapter, hostEvent, result);
    }
    const budgetMs = deps.budgetMs === void 0 ? hookBudgetMs(canonicalEvent) : deps.budgetMs;
    const config = budgetMs ? { ...baseConfig, deadlineAt: Date.now() + budgetMs } : baseConfig;
    const log = deps.log || stderrLog;
    const client = deps.client || requireOperation(deps.createClient, "createClient")(config, log);
    telemetry = deps.telemetry || (typeof deps.createTelemetry === "function" ? deps.createTelemetry({ client, config }) : null);
    if (canonicalEvent === "SessionStart") {
      result = await requireOperation(deps.runSessionStart, "runSessionStart")({ input, client, config, log });
    } else if (canonicalEvent === "UserPromptSubmit") {
      result = await requireOperation(deps.runInject, "runInject")({ input, client, config, search: deps.searchMemory, log });
    } else if (canonicalEvent === "Stop" || canonicalEvent === "SubagentStop") {
      const counter = deps.counter || requireOperation(deps.createTurnCounter, "createTurnCounter")({ stateDir: env.EVERME_STATE_DIR });
      const checkpointStore = deps.checkpointStore || (typeof deps.createTranscriptCheckpointStore === "function" ? deps.createTranscriptCheckpointStore({ stateDir: env.EVERME_STATE_DIR }) : void 0);
      const sessionState = deps.sessionState || (typeof deps.createSessionState === "function" ? deps.createSessionState({ stateDir: env.EVERME_STATE_DIR }) : void 0);
      result = await requireOperation(deps.runStore, "runStore")({
        input,
        adapter,
        client,
        config,
        counter,
        checkpointStore,
        sessionState,
        stateDir: env.EVERME_STATE_DIR,
        log,
        diagnostic: (line) => {
          throw new Error(line);
        },
        telemetry
      });
    } else if (canonicalEvent === "PostToolUse") {
      if (typeof adapter.bufferToolUse === "function") {
        result = await adapter.bufferToolUse(input, { stateDir: env.EVERME_STATE_DIR });
      }
    } else if (canonicalEvent === "SessionEnd" || canonicalEvent === "PreCompact") {
      const sessionState = deps.sessionState || (typeof deps.createSessionState === "function" ? deps.createSessionState({ stateDir: env.EVERME_STATE_DIR }) : void 0);
      const checkpointStore = deps.checkpointStore || (typeof deps.createTranscriptCheckpointStore === "function" ? deps.createTranscriptCheckpointStore({ stateDir: env.EVERME_STATE_DIR }) : void 0);
      result = await requireOperation(deps.runBoundaryFlush, "runBoundaryFlush")({
        input,
        adapter,
        client,
        sessionState,
        checkpointStore,
        stateDir: env.EVERME_STATE_DIR,
        log,
        diagnostic: (line) => {
          throw new Error(line);
        }
      });
    }
    return formatOutput(adapter, hostEvent, result);
  } catch (error) {
    writeDiagnostic(hostEvent, error, deps.redactError || redactError, deps.writeStderr);
    try {
      await telemetry?.report(hookDegradedEvent({ hookEvent: degradedEvent, code: degradedCode(error) }));
    } catch {
    }
    return formatOutput(adapter, hostEvent, { block: "", count: 0, degraded: true });
  }
}
function resolveRuntimeConfig(env) {
  const agentToken = env.EVERME_AGENT_TOKEN || env.EVERME_API_KEY || "";
  const authMode = env.EVERME_AGENT_TOKEN ? "evt" : env.EVERME_API_KEY ? "emk" : "none";
  const knobs = resolveHookKnobs(env);
  return {
    ...resolveConfig({
      apiBase: env.EVERME_API_BASE,
      agentId: env.EVERME_AGENT_ID,
      agentToken,
      ...knobs
    }),
    ...knobs,
    authMode,
    isConfigured: Boolean(agentToken)
  };
}
async function loadRuntimeEnv(adapter, baseEnv) {
  const merged = { ...baseEnv };
  const file = adapter.envFile?.();
  if (!file) return merged;
  let raw;
  try {
    raw = await readFile2(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return merged;
    throw error;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals < 1) continue;
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    if (ROTATED_KEYS.has(key) || !merged[key]) merged[key] = value;
  }
  return merged;
}
function requireOperation(fn, name) {
  if (typeof fn !== "function") throw new TypeError(`hook-runtime requires ${name}`);
  return fn;
}
function writeDiagnostic(event, error, redact = redactError, writer = (line) => process.stderr.write(line)) {
  const redacted = error?.name === "EvermeError" ? describeError(error) : redact(error);
  const reason = String(redacted).replace(/\s+/g, " ").trim();
  const label = {
    SessionStart: "start",
    UserPromptSubmit: "inject",
    Stop: "store",
    SubagentStop: "subagent-store",
    SessionEnd: "summary",
    PreCompact: "compact"
  }[event] || event;
  writer(`EverMe ${label} hook degraded: ${reason}
`);
}
function formatOutput(adapter, event, result) {
  if (typeof adapter?.formatOutput !== "function") return {};
  return adapter.formatOutput(event, result) ?? {};
}

// src/adapter.js
import os2 from "node:os";
import path3 from "node:path";

// src/store-batches.js
import { readFile as readFile3, readdir as readdir2 } from "node:fs/promises";
import path2 from "node:path";

// src/transcript.js
import { createReadStream } from "node:fs";
import { stat as stat2 } from "node:fs/promises";
import { createInterface } from "node:readline";
var INJECTED_CONTEXT_TAGS = [
  "app-context",
  "apps_instructions",
  "codex_internal_context",
  "environment_context",
  "in-app-browser-context",
  "multi_agent_mode",
  "permissions",
  "plugins_instructions",
  "recommended_plugins",
  "skills_instructions"
];
var SYNTHETIC_USER_TAGS = [
  "bash-input",
  "bash-stdout",
  "command-name",
  "local-command-stdout",
  "task-notification",
  "turn_aborted"
];
function readLastTurn(transcriptPath) {
  return readTranscript(transcriptPath, { lastTurnOnly: true });
}
function readCanonicalTranscript(transcriptPath) {
  return readTranscript(transcriptPath, { lastTurnOnly: false });
}
async function readTranscript(transcriptPath, { lastTurnOnly }) {
  if (!transcriptPath) return [];
  const legacyUsersBySegment = await collectLegacyUserMessages(transcriptPath);
  const fallbackTimestampBase = await transcriptFallbackTimestampBase(transcriptPath);
  const lines = createInterface({
    input: createReadStream(transcriptPath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  const state = newParseState(legacyUsersBySegment);
  let messages = [];
  let lineNumber = 0;
  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    lineNumber += 1;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = event?.payload;
    if (event?.type === "session_meta") {
      observeSessionMeta(state, payload);
      if (lastTurnOnly) messages = [];
      continue;
    }
    if (skipsInheritedSubagentEvent(state, event)) continue;
    if (event?.type === "event_msg") {
      continue;
    }
    if (event?.type !== "response_item" || !payload) continue;
    const message = mapPayload(
      payload,
      event.timestamp,
      fallbackTimestampBase + lineNumber,
      lineNumber,
      state
    );
    if (!message) continue;
    if (lastTurnOnly && message.role === "user") {
      messages = [message];
    } else {
      messages.push(message);
    }
  }
  return messages;
}
async function collectLegacyUserMessages(transcriptPath) {
  const usersBySegment = [];
  const lines = createInterface({
    input: createReadStream(transcriptPath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  const state = newParseState([]);
  for await (const rawLine of lines) {
    let event;
    try {
      event = JSON.parse(rawLine);
    } catch {
      continue;
    }
    const payload = event?.payload;
    if (event?.type === "session_meta") {
      observeSessionMeta(state, payload);
      continue;
    }
    if (skipsInheritedSubagentEvent(state, event) || state.isSubagent || event?.type !== "event_msg" || payload?.type !== "user_message" || typeof payload.message !== "string") continue;
    const text = payload.message.trim();
    if (!text) continue;
    if (!usersBySegment[state.segmentIndex]) usersBySegment[state.segmentIndex] = /* @__PURE__ */ new Map();
    const users = usersBySegment[state.segmentIndex];
    users.set(text, (users.get(text) || 0) + 1);
  }
  return usersBySegment;
}
function newParseState(legacyUsersBySegment) {
  return {
    historyMode: "",
    isSubagent: false,
    segmentIndex: 0,
    seenSessionMeta: false,
    outerSessionIsSubagent: false,
    hasSubagentHistoryStart: false,
    subagentHistoryStart: 0,
    legacyUsersBySegment,
    legacyUserMessages: new Map(legacyUsersBySegment[0] || []),
    pendingLegacyToolCallIds: []
  };
}
function observeSessionMeta(state, payload) {
  const firstSessionMeta = !state.seenSessionMeta;
  if (!firstSessionMeta) state.segmentIndex += 1;
  else state.seenSessionMeta = true;
  if (firstSessionMeta) state.outerSessionIsSubagent = sessionMetaIsSubagent(payload);
  if (firstSessionMeta || !state.outerSessionIsSubagent) {
    state.historyMode = typeof payload?.history_mode === "string" ? payload.history_mode : "";
    state.isSubagent = sessionMetaIsSubagent(payload);
    state.hasSubagentHistoryStart = Number.isFinite(payload?.subagent_history_start_ordinal);
    state.subagentHistoryStart = state.hasSubagentHistoryStart ? Math.trunc(payload.subagent_history_start_ordinal) : 0;
  } else {
    state.isSubagent = true;
  }
  state.legacyUserMessages = new Map(state.legacyUsersBySegment[state.segmentIndex] || []);
  state.pendingLegacyToolCallIds = [];
}
function skipsInheritedSubagentEvent(state, event) {
  return state.isSubagent && state.hasSubagentHistoryStart && Number.isFinite(event?.ordinal) && Math.trunc(event.ordinal) < state.subagentHistoryStart;
}
function sessionMetaIsSubagent(payload) {
  if (payload && payload.thread_source !== void 0 && payload.thread_source !== null) {
    return String(payload.thread_source).trim() === "subagent";
  }
  return Boolean(payload?.parent_thread_id);
}
function mapPayload(payload, timestampValue, fallbackTimestamp, lineNumber, state) {
  const timestamp = normalizeTimestamp2(timestampValue, fallbackTimestamp);
  if (payload.type === "message") {
    if (payload.role === "developer") return null;
    const rawText = contentText(payload.content);
    if (!rawText) return null;
    if (payload.role === "user") {
      if (state.isSubagent) return null;
      const content = normalizeUserMessage(state, rawText);
      if (!content) return null;
      state.pendingLegacyToolCallIds = [];
      return { role: "user", ...stamp(timestamp), content: capText(content) };
    }
    if (payload.role !== "assistant") return null;
    const legacyTool = mapLegacyToolMessage(state, rawText, timestamp, lineNumber);
    if (legacyTool.matched) return legacyTool.message;
    return { role: "assistant", ...stamp(timestamp), content: capText(rawText) };
  }
  if (payload.type === "function_call" || payload.type === "custom_tool_call") {
    const custom = payload.type === "custom_tool_call";
    return {
      role: "assistant",
      ...stamp(timestamp),
      toolCalls: [{
        id: payload.call_id || `${custom ? "codex_custom_tool" : "codex_tool"}_${timestamp ?? "untimed"}`,
        type: "function",
        name: payload.name || "unknown",
        arguments: redactText(argumentText(custom ? payload.input : payload.arguments))
      }]
    };
  }
  if (["function_call_output", "custom_tool_call_output"].includes(payload.type) && payload.call_id) {
    return {
      role: "tool",
      ...stamp(timestamp),
      toolCallId: payload.call_id,
      content: capText(outputText(payload.output) || "tool result")
    };
  }
  if (payload.type === "web_search_call") {
    return {
      role: "assistant",
      ...stamp(timestamp),
      toolCalls: [{
        id: `codex_web_search_${timestamp ?? "untimed"}_${lineNumber}`,
        type: "function",
        name: "web_search",
        arguments: redactText(argumentText(payload.action))
      }]
    };
  }
  if (payload.type === "agent_message") return null;
  return null;
}
function normalizeUserMessage(state, text) {
  if (state.historyMode !== "paginated") {
    const remaining = state.legacyUserMessages.get(text) || 0;
    if (remaining === 0) return "";
    state.legacyUserMessages.set(text, remaining - 1);
    return text;
  }
  return normalizePaginatedUserText(text);
}
function normalizePaginatedUserText(text) {
  let trimmed = text.trim();
  const tags = [...INJECTED_CONTEXT_TAGS, ...SYNTHETIC_USER_TAGS, "command-args", "command-message"];
  while (trimmed) {
    const command = commandIntent(trimmed);
    if (command) return command;
    const agentsRemainder = stripLeadingAgentsInstructions(trimmed);
    if (agentsRemainder !== null) {
      trimmed = agentsRemainder;
      continue;
    }
    let stripped = false;
    for (const tag of tags) {
      const remainder = stripLeadingEnvelope(trimmed, tag);
      if (remainder !== null) {
        trimmed = remainder;
        stripped = true;
        break;
      }
    }
    if (!stripped) break;
  }
  return !trimmed || hasEnvelopePrefix(trimmed, "command-message") ? "" : trimmed;
}
function commandIntent(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("<command-message>")) return "";
  const name = envelopeValue(trimmed, "command-name");
  if (!name?.startsWith("/")) return "";
  const args = envelopeValue(trimmed, "command-args");
  return `${name} ${args}`.trim();
}
function stripLeadingEnvelope(text, tag) {
  if (!hasEnvelopePrefix(text, tag)) return null;
  const openEnd = text.indexOf(">");
  if (openEnd < 0) return null;
  const close = `</${tag}>`;
  const closeStart = text.indexOf(close, openEnd + 1);
  if (closeStart < 0) return null;
  return text.slice(closeStart + close.length).trim();
}
function hasEnvelopePrefix(text, tag) {
  if (!text.startsWith(`<${tag}`)) return false;
  return [">", " ", "	", "\n", "\r"].includes(text.at(tag.length + 1));
}
function stripLeadingAgentsInstructions(text) {
  if (!text.startsWith("# AGENTS.md instructions for ") || !text.includes("<INSTRUCTIONS>")) return null;
  const close = "</INSTRUCTIONS>";
  const closeStart = text.indexOf(close);
  return closeStart < 0 ? "" : text.slice(closeStart + close.length).trim();
}
function envelopeValue(text, tag) {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = text.indexOf(open);
  if (start < 0) return "";
  const valueStart = start + open.length;
  const end = text.indexOf(close, valueStart);
  return end < 0 ? "" : text.slice(valueStart, end).trim();
}
function mapLegacyToolMessage(state, text, timestamp, lineNumber) {
  const envelope = legacyToolEnvelope(text);
  if (!envelope) return { matched: false, message: null };
  if (envelope.kind === "call") {
    const callId = `codex_legacy_tool_${lineNumber}`;
    state.pendingLegacyToolCallIds.push(callId);
    return {
      matched: true,
      message: {
        role: "assistant",
        ...stamp(timestamp),
        toolCalls: [{
          id: callId,
          type: "function",
          name: envelope.name,
          arguments: redactText(envelope.body)
        }]
      }
    };
  }
  if (state.pendingLegacyToolCallIds.length !== 1) {
    state.pendingLegacyToolCallIds = [];
    return { matched: true, message: null };
  }
  const [toolCallId] = state.pendingLegacyToolCallIds;
  state.pendingLegacyToolCallIds = [];
  return {
    matched: true,
    message: {
      role: "tool",
      ...stamp(timestamp),
      toolCallId,
      content: capText(envelope.body || "tool result")
    }
  };
}
function legacyToolEnvelope(text) {
  const trimmed = text.trim();
  const callMatch = trimmed.match(/^\[external_agent_tool_call:\s*([^\]]+)\]\s*([\s\S]*?)\s*\[\/external_agent_tool_call\]$/);
  if (callMatch) {
    return { kind: "call", name: callMatch[1].trim() || "unknown", body: callMatch[2].trim() };
  }
  const resultMatch = trimmed.match(/^\[external_agent_tool_result\]\s*([\s\S]*?)\s*\[\/external_agent_tool_result\]$/);
  if (resultMatch) return { kind: "result", body: resultMatch[1].trim() };
  return null;
}
function stamp(timestamp) {
  return timestamp === void 0 ? {} : { timestamp };
}
function contentText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
    } else if (["input_text", "output_text", "text"].includes(item?.type) && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts.join("\n").trim();
}
function outputText(value) {
  return typeof value === "string" ? value.trim() : contentText(value);
}
function argumentText(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}
function normalizeTimestamp2(value, fallbackTimestamp) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e10 ? Math.trunc(value) : Math.trunc(value * 1e3);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallbackTimestamp;
}
async function transcriptFallbackTimestampBase(transcriptPath) {
  try {
    return Math.trunc((await stat2(transcriptPath)).mtimeMs);
  } catch {
    return 0;
  }
}
function capText(value) {
  return capRunes(redactText(String(value || "").trim()));
}
function redactText(value) {
  return String(value || "").replace(/sk-[A-Za-z0-9_-]{16,}/g, "[redacted]").replace(/evt_[A-Za-z0-9_-]{8,}/g, "[redacted]").replace(/emk_[A-Za-z0-9_-]{8,}/g, "[redacted]").replace(/ghp_[A-Za-z0-9]{20,}/g, "[redacted]").replace(/AKIA[0-9A-Z]{16}/g, "[redacted]").replace(/bearer\s+[A-Za-z0-9._=-]{10,}/gi, "[redacted]").replace(/X-Amz-Signature=[A-Za-z0-9%]+/g, "[redacted]").replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted]");
}

// src/store-batches.js
async function readCodexStoreBatches(input, { checkpointStore } = {}) {
  if (!input?.sessionId || !input?.transcriptPath) return [];
  const batches = [];
  const root = await transcriptBatch({
    checkpointStore,
    conversationId: input.sessionId,
    initialTailOnly: true,
    transcriptPath: input.transcriptPath
  });
  if (root) batches.push(root);
  for (const child of await completedDescendants(input.transcriptPath, input.sessionId)) {
    const batch = await transcriptBatch({
      checkpointStore,
      conversationId: child.id,
      initialTailOnly: false,
      transcriptPath: child.path
    });
    if (batch) batches.push(batch);
  }
  return batches;
}
async function transcriptBatch({ checkpointStore, conversationId, initialTailOnly, transcriptPath }) {
  const canonical = await readCanonicalTranscript(transcriptPath);
  const stateId = `codex:${conversationId}`;
  const checkpoint = checkpointStore ? await checkpointStore.read(stateId) : { initialized: false, uploadedCount: 0 };
  let messages;
  if (checkpoint.initialized && checkpoint.uploadedCount <= canonical.length) {
    messages = canonical.slice(checkpoint.uploadedCount);
  } else {
    messages = initialTailOnly ? await readLastTurn(transcriptPath) : canonical;
  }
  if (!messages.length) return null;
  return {
    conversationId,
    messages,
    checkpoint: { stateId, uploadedCount: canonical.length }
  };
}
async function completedDescendants(rootPath, rootId) {
  let names;
  try {
    names = await readdir2(path2.dirname(rootPath));
  } catch {
    return [];
  }
  const candidates = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const candidatePath = path2.join(path2.dirname(rootPath), name);
    if (candidatePath === rootPath) continue;
    const metadata = await rolloutMetadata(candidatePath);
    if (metadata?.isSubagent && metadata.complete) {
      candidates.push({ ...metadata, path: candidatePath });
    }
  }
  const descendants = [];
  const parents = /* @__PURE__ */ new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates) {
      if (candidate.selected || !parents.has(candidate.parentId)) continue;
      candidate.selected = true;
      parents.add(candidate.id);
      descendants.push(candidate);
      changed = true;
    }
  }
  return descendants;
}
async function rolloutMetadata(transcriptPath) {
  let raw;
  try {
    raw = await readFile3(transcriptPath, "utf8");
  } catch {
    return null;
  }
  let metadata;
  let complete = false;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!metadata && event?.type === "session_meta") {
      const payload = event.payload || {};
      const id = stringValue(payload.id || payload.session_id);
      const parentId = stringValue(payload.parent_thread_id || payload.forked_from_id);
      metadata = {
        id,
        parentId,
        isSubagent: payload.thread_source === "subagent" || Boolean(parentId)
      };
    }
    if (event?.type === "event_msg" && event?.payload?.type === "task_complete" || event?.type === "task_complete") {
      complete = true;
    }
  }
  if (!metadata?.id || !metadata.parentId) return null;
  return { ...metadata, complete };
}
function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

// src/adapter.js
var CONTEXT_EVENTS = /* @__PURE__ */ new Set(["SessionStart", "UserPromptSubmit"]);
var codexAdapter = {
  platform: "codex",
  envFile() {
    return process.env.EVERME_ENV_FILE_PATH || path3.join(os2.homedir(), ".codex", "everme.env");
  },
  normalizeInput(rawInput) {
    return {
      // No session_id → empty (writes are skipped downstream), like
      // cursor/devin: a constant fallback would merge unrelated sessions
      // into one conversation on the backend.
      sessionId: rawInput?.session_id || "",
      transcriptPath: rawInput?.transcript_path || "",
      cwd: rawInput?.cwd || "",
      prompt: rawInput?.prompt || "",
      turnId: rawInput?.turn_id || "",
      source: rawInput?.source || ""
    };
  },
  readLastTurn(input) {
    return readLastTurn(input?.transcriptPath);
  },
  readStoreBatches(input, options) {
    return readCodexStoreBatches(input, options);
  },
  formatOutput(event, { block = "" } = {}) {
    if (!CONTEXT_EVENTS.has(event) || !block) return {};
    return {
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: block
      }
    };
  }
};

// bin/hook.js
main().catch((error) => {
  const reason = redactError(error).replace(/\s+/g, " ").trim();
  process.stderr.write(`EverMe Codex hook degraded: ${reason}
`);
  process.exitCode = 0;
});
async function main() {
  const [, , command, event] = process.argv;
  if (command !== "hook" || !event) return;
  const input = await readStdinJSON();
  const output = await runHook(event, input, codexAdapter);
  if (output && Object.keys(output).length) {
    process.stdout.write(JSON.stringify(output));
  }
}
async function readStdinJSON() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}
