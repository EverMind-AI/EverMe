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
async function requestMeta(client, method, path5, body, opts) {
  if (typeof client?.requestWithMeta === "function") {
    return client.requestWithMeta(method, path5, body, opts);
  }
  return { result: await client.request(method, path5, body, opts), requestId: "" };
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
  async function requestWithMeta(method, path5, body, { timeoutMs = TIMEOUT_MS, query } = {}) {
    const requestId = randomUUID();
    const url = buildUrl(cfg.baseUrl, path5, query);
    const init = {
      method,
      headers: headers(requestId),
      body: body == null ? void 0 : JSON.stringify(body)
    };
    return execWithRetry(url, init, boundedTimeoutMs(timeoutMs, cfg.deadlineAt), log, requestId);
  }
  async function request(method, path5, body, opts) {
    const { result } = await requestWithMeta(method, path5, body, opts);
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
function buildUrl(base, path5, query) {
  const qs = query ? new URLSearchParams() : null;
  if (qs) {
    for (const [k, v] of Object.entries(query)) {
      if (v == null || v === "") continue;
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
      else qs.set(k, String(v));
    }
  }
  const q = qs?.toString();
  return q ? `${base}${path5}?${q}` : `${base}${path5}`;
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
function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => typeof p === "string" ? p : p?.text || p?.content || "").filter(Boolean).join("\n");
  }
  if (content && typeof content === "object" && typeof content.text === "string") {
    return content.text;
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

// ../agent-sdk/src/agent-batches.js
var TURN_BOUNDARY = 2;
var TOOL_BOUNDARY = 1;
function batchAgentMessages(messages, maxMessages, metadata = [], alignTails = false) {
  const boundaries2 = classifyBoundaries(messages, metadata);
  const batches = [];
  for (let start = 0; start < messages.length; ) {
    const limit = Math.min(start + maxMessages, messages.length);
    let end = limit === messages.length ? limit : chooseBoundary(boundaries2, start, limit);
    if (alignTails && start > 0 && messages[start]?.role !== "user") {
      for (let next = start + 1; next < end; next += 1) {
        if (messages[next]?.role === "user") {
          end = next;
          break;
        }
      }
    }
    batches.push(messages.slice(start, end));
    start = end;
  }
  return batches;
}
function classifyBoundaries(messages, metadata) {
  const boundaries2 = new Array(messages.length + 1).fill(0);
  const pending = /* @__PURE__ */ new Map();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    for (const call of message.toolCalls || []) {
      pending.set(call.id, (pending.get(call.id) || 0) + 1);
    }
    const matched = matchResult(messages, index, pending);
    if (pending.size !== 0) continue;
    if (isTurnEnd(messages, metadata, index)) {
      boundaries2[index + 1] = TURN_BOUNDARY;
    } else if (matched) {
      boundaries2[index + 1] = TOOL_BOUNDARY;
    }
  }
  return boundaries2;
}
function matchResult(messages, index, pending) {
  const message = messages[index];
  const count = pending.get(message.toolCallId);
  if (message.role !== "tool" || !count) return false;
  const next = messages[index + 1];
  if (next?.role === "tool" && next.toolCallId === message.toolCallId) return false;
  if (count === 1) pending.delete(message.toolCallId);
  else pending.set(message.toolCallId, count - 1);
  return true;
}
function isTurnEnd(messages, metadata, index) {
  const message = messages[index];
  if (message.role !== "assistant" || message.toolCalls?.length) return false;
  const current = metadata[index];
  const next = metadata[index + 1];
  if (current?.turnComplete === false) return false;
  return current?.turnComplete === true || messages[index + 1]?.role === "user" || Boolean(current?.turnId && next?.turnId && current.turnId !== next.turnId);
}
function chooseBoundary(boundaries2, start, limit) {
  for (const kind of [TURN_BOUNDARY, TOOL_BOUNDARY]) {
    for (let end = limit; end > start; end -= 1) {
      if (boundaries2[end] === kind) return end;
    }
  }
  return limit;
}

// ../agent-sdk/src/task-batches.js
var SOFT_BYTES = 64 * 1024;
var HARD_BYTES = 280 * 1024;
var MAX_MESSAGES = 500;
var bytes = (message) => Buffer.byteLength(JSON.stringify(message));
var totalBytes = (messages) => messages.reduce((sum, message) => sum + bytes(message), 0);
var isText = (message) => ["user", "assistant"].includes(message.role) && typeof message.content === "string" && message.content !== "" && !message.toolCalls?.length;
function batchUserTasks(messages, metadata = [], log = {}) {
  const tasks = userTasks(messages);
  const prepared = messages.map((message) => ({ ...message }));
  let trimmed = 0;
  for (const { start, end } of tasks) {
    const task = messages.slice(start, end);
    if (totalBytes(task) <= HARD_BYTES) continue;
    let candidate;
    for (const budget of [4096, 3072, 2048]) {
      candidate = task.map((message) => message.role === "tool" && typeof message.content === "string" ? { ...message, content: trimToolResult(message.content, budget) } : message);
      if (totalBytes(candidate) <= HARD_BYTES) break;
    }
    candidate.forEach((message, index) => {
      if (message.content !== task[index].content) trimmed++;
      prepared[start + index] = message;
    });
  }
  if (trimmed) log.info?.(`[everme] task-batching trimmedToolResults=${trimmed} minBytes=2048 maxBytes=4096`);
  return splitTasks(prepared, metadata, tasks);
}
function userTasks(messages) {
  const tasks = [];
  for (let start = 0; start < messages.length; ) {
    let end = start + 1;
    while (end < messages.length && messages[end].role !== "user") end++;
    tasks.push({ start, end });
    start = end;
  }
  return tasks;
}
function trimToolResult(text, budget) {
  const raw = Buffer.from(text);
  if (raw.length <= budget) return text;
  const marker = (removed) => `
[... trimmed ${removed} bytes of ${raw.length} ...]
`;
  const available = budget - Buffer.byteLength(marker(raw.length));
  let head = Math.floor(available * 7 / 10);
  let tail = raw.length - (available - head);
  while (head > 0 && (raw[head] & 192) === 128) head--;
  while (tail < raw.length && (raw[tail] & 192) === 128) tail++;
  return raw.subarray(0, head).toString() + marker(tail - head) + raw.subarray(tail).toString();
}
function splitTasks(messages, metadata, tasks) {
  const sizes = messages.map(bytes);
  const protectedCuts = /* @__PURE__ */ new Map();
  for (const task of tasks) {
    if (messages[task.start].role !== "user" || task.end - task.start > MAX_MESSAGES || sizes.slice(task.start, task.end).reduce((a, b) => a + b, 0) > HARD_BYTES) continue;
    for (let cut = task.start + 1; cut < task.end; cut++) protectedCuts.set(cut, task);
  }
  const { text, pairs } = boundaries(messages, metadata);
  const batches = [];
  for (let start = 0; start < messages.length; ) {
    let hard = limitEnd(sizes, start, HARD_BYTES);
    if (start > 0 && messages[start].role !== "user") {
      for (let next = start + 1; next < hard; next++) {
        if (messages[next].role === "user") {
          hard = next;
          break;
        }
      }
    }
    const preferred = Math.min(limitEnd(sizes, start, SOFT_BYTES), hard);
    let end = preferred === messages.length ? preferred : chooseText(text, start, preferred, hard);
    if (!end) {
      for (let cut = hard; cut > start; cut--) {
        if (pairs.has(cut)) {
          end = cut;
          break;
        }
      }
    }
    if (!end) end = hard;
    const task = protectedCuts.get(end);
    if (task) end = task.end <= hard ? task.end : task.start;
    batches.push(messages.slice(start, end));
    start = end;
  }
  return batches;
}
function limitEnd(sizes, start, budget) {
  let end = start;
  let size = 0;
  while (end < sizes.length && end - start < MAX_MESSAGES) {
    if (end > start && size + sizes[end] > budget) break;
    size += sizes[end++];
  }
  return end;
}
function complete(messages, metadata, index) {
  if (messages[index].role !== "assistant" || messages[index].toolCalls?.length) return false;
  if (typeof metadata[index]?.turnComplete === "boolean") return metadata[index].turnComplete;
  return messages[index + 1]?.role === "user" || Boolean(metadata[index]?.turnId && metadata[index + 1]?.turnId && metadata[index].turnId !== metadata[index + 1].turnId);
}
function boundaries(messages, metadata) {
  const text = /* @__PURE__ */ new Map();
  const pairs = /* @__PURE__ */ new Set();
  const pending = /* @__PURE__ */ new Map();
  messages.forEach((message, index) => {
    for (const call of message.toolCalls || []) pending.set(call.id, (pending.get(call.id) || 0) + 1);
    const count = pending.get(message.toolCallId);
    const matched = message.role === "tool" && count;
    if (matched) {
      if (count === 1) pending.delete(message.toolCallId);
      else pending.set(message.toolCallId, count - 1);
    }
    if (pending.size) return;
    const end = index + 1;
    if (matched && !(messages[end]?.role === "tool" && messages[end].toolCallId === message.toolCallId)) pairs.add(end);
    if (!isText(message) || message.role === "assistant" && !complete(messages, metadata, index)) return;
    if (end === messages.length || messages[end].role === "user") text.set(end, 2);
    else if (message.role === "assistant" && isText(messages[end])) text.set(end, 1);
  });
  return { text, pairs };
}
function chooseText(boundaries2, start, preferred, hard) {
  for (const kind of [2, 1]) {
    for (let end = preferred; end > start; end--) if (boundaries2.get(end) === kind) return end;
    for (let end = preferred + 1; end <= hard; end++) if (boundaries2.get(end) === kind) return end;
  }
  return 0;
}

// ../agent-sdk/src/turns.js
var USER = "user";
function turnOrdinals(messages) {
  const out = new Array(messages.length);
  let ordinal = 0;
  let seenUser = false;
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === USER) {
      if (seenUser) ordinal += 1;
      seenUser = true;
    }
    out[i] = ordinal;
  }
  return out;
}
function completedTurns(slices, i, baseTurn) {
  const slice = slices[i];
  if (!Array.isArray(slice) || !slice.length) return 0;
  let n = slice.filter((message) => message?.role === USER).length;
  if (slice[0]?.role !== USER && (i > 0 || baseTurn > 0)) n += 1;
  if (i < slices.length - 1) {
    if (slices[i + 1]?.[0]?.role !== USER) n -= 1;
  } else if (slice[slice.length - 1]?.role === USER) {
    n -= 1;
  }
  return n < 0 ? 0 : n;
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
async function saveAgentMemory(client, { conversationId, messages = [], flush = true, sync = false, channel, turns, baseTurn, taskBatching = false, deduplication, syncScope } = {}, log = { info() {
}, warn() {
} }) {
  if (!conversationId) {
    log.info?.("[everme] agent-memory stage=skip reason=missing_conversation_id");
    return null;
  }
  const flushOnly = flush === true && messages.length === 0;
  const stamp2 = Date.now();
  const entries = messages.map((source, i) => ({ source, message: convertAgentMessage(source, stamp2 + i) })).filter(({ message }) => message && (message.content != null || message.toolCalls?.length));
  const converted = entries.map(({ message }) => message);
  if (!converted.length && !flushOnly) {
    log.info?.(`[everme] agent-memory stage=skip reason=no_parseable_messages conversationId=${logValue(conversationId)} inputMessages=${messages.length}`);
    return null;
  }
  if (syncScope) {
    await requireSyncScopeSupport(client, conversationId, syncScope, channel);
  }
  const hasBase = Number.isInteger(baseTurn) && baseTurn >= 0;
  const metadata = entries.map(({ source }) => source);
  const slices = taskBatching ? batchUserTasks(converted, metadata, log) : batchAgentMessages(converted, MAX_MESSAGES_PER_REQUEST, metadata, hasBase);
  if (flushOnly) slices.push([]);
  const ordinals = hasBase ? turnOrdinals(converted) : null;
  const batches = slices.length;
  if (batches > 1) {
    log.info?.(`[everme] agent-memory stage=start conversationId=${logValue(conversationId)} messages=${converted.length} batches=${batches} flush=${flush === true}`);
  }
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
        ...sync === true || !isLast && flush === true ? { sync: true } : {},
        ...channel ? { channel } : {},
        ...syncScope ? { syncScope } : {},
        ...deduplication ? { deduplication } : {},
        ...hasBase ? { baseTurn: sliceBase, turns: sliceTurns } : declaredTurns !== null && slice.length ? { turns: isLast ? declaredTurns : 0 } : {}
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
async function requireSyncScopeSupport(client, conversationId, syncScope, channel) {
  const { result } = await requestMeta(client, "POST", "/mem/agent-memory/state", {
    sessions: [{ conversationId, syncScope }]
  });
  const supported = channel === "hook" ? result?.hookSyncScopeSupported === true : channel === "import" && result?.syncScopeSupported === true;
  if (!supported) {
    throw new Error("Agent memory sync scope is not supported for this channel; upgrade the EverMe server before retrying");
  }
}
async function flushAgentMemory(client, { conversationId } = {}, log) {
  return saveAgentMemory(client, { conversationId, messages: [], flush: true }, log);
}
function convertAgentMessage(msg, fallbackTimestamp) {
  if (!msg || !msg.role) return null;
  const timestamp = normalizeTimestamp(msg.timestamp, fallbackTimestamp);
  if (msg.role === AGENT_MEMORY_ROLES.USER) {
    const content = cap(extractText(msg.content).trim());
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
      content: extractText(msg.content).trim()
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
  const content = cap(textParts.join("\n").trim());
  if (!content && !toolCalls.length) return null;
  return {
    role: AGENT_MEMORY_ROLES.ASSISTANT,
    timestamp,
    ...content ? { content } : {},
    ...toolCalls.length ? { toolCalls } : {},
    ...typeof msg.turnComplete === "boolean" ? { turnComplete: msg.turnComplete } : {}
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
          uploadedCount: nonNegativeInteger(parsed.uploadedCount),
          ...Array.isArray(parsed.nativeMessageIds) ? { nativeMessageIds: parsed.nativeMessageIds } : {}
        };
      } catch (error) {
        if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        return { initialized: false, uploadedCount: 0 };
      }
    },
    async commit(stateId, uploadedCount, identity = {}) {
      await mkdir(stateDir, { recursive: true, mode: 448 });
      const file = fileFor(stateId);
      const next = { initialized: true, uploadedCount: nonNegativeInteger(uploadedCount) };
      if (Array.isArray(identity.nativeMessageIds)) next.nativeMessageIds = identity.nativeMessageIds;
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
      return safe("turn enqueue", () => enqueue({ ...turn, flush: false, sync: true }));
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
    enqueue: (turn) => saveAgentMemory(client, { ...turn, channel: "hook", turns: 1, taskBatching: adapter.taskBatching === true }, log),
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
    enqueue: (batch) => saveAgentMemory(client, { ...batch, taskBatching: adapter.taskBatching === true }, log),
    flush: (conversationId) => flushAgentMemory(client, { conversationId }, log),
    diagnostic,
    rethrowOnError: true
  });
  let requestId;
  let status;
  let count = 0;
  const perTurn = adapter?.turnBoundary === "stop";
  for (const [index, batch] of ready.entries()) {
    const payload = perTurn ? { ...batch, channel: "hook", turns: Number.isInteger(batch.turns) ? batch.turns : index === ready.length - 1 ? 1 : 0 } : batch;
    const saved = config.flushMode === "legacy" ? await runtime.flushSession(payload) : await runtime.enqueueTurn(payload);
    requestId = saved?.requestId || requestId;
    status = saved?.status || status;
    count += batch.messages.length;
    if (batch.checkpoint && checkpointStore) {
      await checkpointStore.commit(batch.checkpoint.stateId, batch.checkpoint.uploadedCount, batch.checkpoint);
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
  if (!input?.sessionId) {
    log.info?.("[everme] boundary-flush stage=skip reason=missing_session_id");
    return { block: "", count: 0 };
  }
  const runtime = createHookRuntime({
    enqueue: (turn) => saveAgentMemory(client, { ...turn, taskBatching: adapter.taskBatching === true }, log),
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
import path4 from "node:path";

// src/store-batches.js
import { readFile as readFile3, readdir as readdir2 } from "node:fs/promises";
import path3 from "node:path";

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
var KNOWN_EVENT_MESSAGES = /* @__PURE__ */ new Set([
  "agent_message",
  "agent_reasoning",
  "context_compacted",
  "item_completed",
  "mcp_tool_call_begin",
  "mcp_tool_call_end",
  "patch_apply_begin",
  "patch_apply_end",
  "reasoning",
  "task_complete",
  "task_started",
  "sub_agent_activity",
  "thread_goal_updated",
  "thread_rolled_back",
  "thread_settings_applied",
  "token_count",
  "turn_aborted",
  "turn_complete",
  "user_message",
  "web_search_begin",
  "web_search_end"
]);
function readLastTurn(transcriptPath, options = {}) {
  return readTranscript(transcriptPath, { ...options, lastTurnOnly: true });
}
function readCanonicalTranscript(transcriptPath, options = {}) {
  return readTranscript(transcriptPath, { ...options, lastTurnOnly: false });
}
async function readTranscript(transcriptPath, { lastTurnOnly, diagnostic = () => {
} }) {
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
      countDiagnostic(state, "malformed_json");
      continue;
    }
    const payload = event?.payload;
    if (event?.type === "session_meta") {
      observeSessionMeta(state, payload);
      if (lastTurnOnly) messages = [];
      continue;
    }
    if (skipsInheritedSubagentEvent(state, event)) {
      countDiagnostic(state, "inherited_context");
      continue;
    }
    observeTurn(state, payload);
    if (event?.type === "turn_context") {
      continue;
    }
    if (["task_complete", "turn_complete"].includes(event?.type) || event?.type === "event_msg" && ["task_complete", "turn_complete"].includes(payload?.type)) {
      if (event.type !== "event_msg" && typeof event.turn_id === "string" && event.turn_id) {
        observeTurn(state, event);
      }
      const last = messages.at(-1);
      if (last && last === state.lastAssistant && last.turnComplete !== false && (last.turnId || "") === state.turnId) {
        setBoundaryMetadata(last, "turnComplete", true);
      }
      continue;
    }
    if (event?.type === "event_msg") {
      if (!KNOWN_EVENT_MESSAGES.has(payload?.type)) countDiagnostic(state, "unknown_event_message");
      continue;
    }
    if (event?.type !== "response_item" || !payload) {
      if (!["compacted"].includes(event?.type)) countDiagnostic(state, "unknown_event");
      continue;
    }
    const message = mapPayload(
      payload,
      event.timestamp,
      fallbackTimestampBase + lineNumber,
      lineNumber,
      state
    );
    if (!message) continue;
    if (state.turnId) setBoundaryMetadata(message, "turnId", state.turnId);
    if (lastTurnOnly && message.role === "user") {
      messages = [message];
    } else {
      messages.push(message);
    }
  }
  if (state.isSubagent && !messages.some((message) => message.role === "user")) {
    countDiagnostic(state, "subagent_without_user");
    messages = [];
  }
  diagnoseToolPairs(messages, state);
  if (Object.keys(state.diagnostics).length) {
    const counts = Object.entries(state.diagnostics).map(([reason, count]) => `${reason}=${count}`).join(" ");
    diagnostic(`[everme] codex parse lines=${lineNumber} messages=${messages.length} ${counts}`.slice(0, 1024));
  }
  return messages;
}
function countDiagnostic(state, reason) {
  state.diagnostics[reason] = (state.diagnostics[reason] || 0) + 1;
}
function sourceCallId(payload) {
  return typeof payload?.call_id === "string" && payload.call_id.trim() ? payload.call_id : "";
}
function diagnoseToolPairs(messages, state) {
  const seen = /* @__PURE__ */ new Set();
  const pending = /* @__PURE__ */ new Map();
  for (const message of messages) {
    for (const call of message.toolCalls || []) {
      if (seen.has(call.id)) countDiagnostic(state, "duplicate_call_id");
      seen.add(call.id);
      pending.set(call.id, (pending.get(call.id) || 0) + 1);
    }
    if (message.role !== "tool") continue;
    const count = pending.get(message.toolCallId) || 0;
    if (!count) countDiagnostic(state, "orphan_result");
    else if (count === 1) pending.delete(message.toolCallId);
    else pending.set(message.toolCallId, count - 1);
  }
  for (const count of pending.values()) {
    state.diagnostics.missing_result = (state.diagnostics.missing_result || 0) + count;
  }
}
function setBoundaryMetadata(message, key, value) {
  Object.defineProperty(message, key, { value, writable: true, configurable: true });
  return message;
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
function observeTurn(state, payload) {
  const turnId = payload?.turn_id || payload?.internal_chat_message_metadata_passthrough?.turn_id;
  if (typeof turnId !== "string" || !turnId) return;
  state.turnId = turnId;
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
    diagnostics: {},
    turnId: "",
    lastAssistant: null
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
  state.turnId = "";
  state.lastAssistant = null;
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
    if (["developer", "system"].includes(payload.role)) {
      countDiagnostic(state, "system_message");
      return null;
    }
    const rawText = contentText(payload.content);
    if (!rawText) {
      countDiagnostic(state, "empty_or_nontext_message");
      return null;
    }
    if (payload.role === "user") {
      if (state.isSubagent) {
        countDiagnostic(state, "subagent_user");
        return null;
      }
      const content = normalizeUserMessage(state, rawText);
      if (!content) {
        countDiagnostic(state, "injected_user");
        return null;
      }
      if (content !== rawText) countDiagnostic(state, "stripped_user_wrapper");
      return { role: "user", ...stamp(timestamp), content: capText(content) };
    }
    if (payload.role !== "assistant") {
      countDiagnostic(state, "unknown_role");
      return null;
    }
    if (legacyToolEnvelope(rawText)) {
      countDiagnostic(state, "dropped_legacy_tool_without_id");
      return null;
    }
    const message = { role: "assistant", ...stamp(timestamp), content: capText(rawText) };
    if (typeof payload.phase === "string" && payload.phase) {
      setBoundaryMetadata(message, "turnComplete", payload.phase === "final_answer");
    }
    state.lastAssistant = message;
    return message;
  }
  if (payload.type === "function_call" || payload.type === "custom_tool_call") {
    const custom = payload.type === "custom_tool_call";
    const callId = sourceCallId(payload);
    if (!callId) {
      countDiagnostic(state, "dropped_missing_call_id");
      return null;
    }
    return {
      role: "assistant",
      ...stamp(timestamp),
      toolCalls: [{
        id: callId,
        type: "function",
        name: payload.name || "unknown",
        arguments: redactText(custom ? customToolArguments(payload.input) : argumentText(payload.arguments))
      }]
    };
  }
  if (["function_call_output", "custom_tool_call_output"].includes(payload.type)) {
    const toolCallId = sourceCallId(payload);
    if (!toolCallId) {
      countDiagnostic(state, "dropped_missing_result_id");
      return null;
    }
    if (!Object.hasOwn(payload, "output")) countDiagnostic(state, "missing_output_field");
    return {
      role: "tool",
      ...stamp(timestamp),
      toolCallId,
      content: redactText(outputText(payload.output))
    };
  }
  if (payload.type === "web_search_call") {
    return setBoundaryMetadata({
      role: "assistant",
      ...stamp(timestamp),
      // This source record has no paired result; preserve it without inventing one.
      content: capText(JSON.stringify(payload))
    }, "turnComplete", false);
  }
  if (payload.type === "agent_message") {
    countDiagnostic(state, "internal_agent_message");
    return null;
  }
  if (payload.type === "reasoning") {
    countDiagnostic(state, "internal_reasoning");
    return null;
  }
  countDiagnostic(state, "unknown_payload");
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
    const objective = goalObjective(trimmed);
    if (objective) return objective;
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
function goalObjective(text) {
  const prefix = '<codex_internal_context source="goal">';
  if (!text.startsWith(prefix)) return "";
  const close = "</codex_internal_context>";
  const end = text.indexOf(close, prefix.length);
  if (end < 0) return "";
  const body = text.slice(prefix.length, end);
  if (!body.includes("The objective below is user-provided data.")) return "";
  const objective = envelopeValue(body, "objective");
  if (!objective) return "";
  const suffix = normalizePaginatedUserText(text.slice(end + close.length));
  return suffix ? `${objective}

${suffix}` : objective;
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
  if (typeof value === "string") {
    if (!value.trim()) return "{}";
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify({ input: value });
    }
  }
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}
function customToolArguments(value) {
  if (value == null || value === "") return "{}";
  try {
    return JSON.stringify({ input: value });
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

// src/fragment.js
import { createReadStream as createReadStream2 } from "node:fs";
import path2 from "node:path";
import { createInterface as createInterface2 } from "node:readline";
var UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
var ROLLOUT = new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${UUID})(?:_(${UUID}))?\\.jsonl$`);
async function readFragmentScope(transcriptPath) {
  const stream = createReadStream2(transcriptPath, { encoding: "utf8" });
  const lines = createInterface2({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event?.type !== "session_meta") continue;
      if (event.payload?.history_mode !== "paginated") return "";
      const match = path2.basename(transcriptPath).match(ROLLOUT);
      if (!match) {
        if (event.payload?.history_base?.thread_id) {
          throw new Error("codex paginated fragment has no native rollout filename identity");
        }
        return "";
      }
      return `codex-fragment-${match[2] || match[1]}`;
    }
    return "";
  } finally {
    lines.close();
    stream.destroy();
  }
}

// src/store-batches.js
async function readCodexStoreBatches(input, { checkpointStore, diagnostic = () => {
} } = {}) {
  if (!input?.sessionId || !input?.transcriptPath) return [];
  const batches = [];
  const root = await transcriptBatch({
    checkpointStore,
    diagnostic,
    conversationId: input.sessionId,
    initialTailOnly: true,
    transcriptPath: input.transcriptPath
  });
  if (root) batches.push(root);
  for (const child of await completedDescendants(input.transcriptPath, input.sessionId)) {
    const batch = await transcriptBatch({
      checkpointStore,
      diagnostic,
      conversationId: child.id,
      initialTailOnly: false,
      transcriptPath: child.path
    });
    if (batch) batches.push(batch);
  }
  return batches;
}
async function transcriptBatch({ checkpointStore, conversationId, initialTailOnly, transcriptPath, diagnostic }) {
  const canonical = await readCanonicalTranscript(transcriptPath, { diagnostic });
  if (!canonical.length) return null;
  const syncScope = await readFragmentScope(transcriptPath);
  const stateId = syncScope ? `codex:${conversationId}:${syncScope}` : `codex:${conversationId}`;
  const checkpoint = checkpointStore ? await checkpointStore.read(stateId) : { initialized: false, uploadedCount: 0 };
  const continuation = checkpoint.initialized && checkpoint.uploadedCount <= canonical.length;
  const messages = continuation ? canonical.slice(checkpoint.uploadedCount) : initialTailOnly ? await readLastTurn(transcriptPath) : canonical;
  if (!messages.length) return null;
  return {
    conversationId,
    ...syncScope ? { syncScope } : {},
    messages,
    // Address by absolute turn only when everything before the slice is
    // known to be covered: a checkpoint continuation, or the whole canonical
    // transcript. A cold-start tail must not claim the turns it skipped, or
    // the importer would trim the history it still has to bring in; left
    // unaddressed, the gate appends it at the current watermark instead.
    ...(continuation || messages.length === canonical.length) && messages.length <= canonical.length ? { baseTurn: turnOrdinals(canonical)[canonical.length - messages.length] } : { turns: 0 },
    checkpoint: { stateId, uploadedCount: canonical.length }
  };
}
async function completedDescendants(rootPath, rootId) {
  let names;
  try {
    names = await readdir2(path3.dirname(rootPath));
  } catch {
    return [];
  }
  const candidates = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const candidatePath = path3.join(path3.dirname(rootPath), name);
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
  let complete2 = false;
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
      complete2 = true;
    }
  }
  if (!metadata?.id || !metadata.parentId) return null;
  return { ...metadata, complete: complete2 };
}
function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

// src/adapter.js
var CONTEXT_EVENTS = /* @__PURE__ */ new Set(["SessionStart", "UserPromptSubmit"]);
var codexAdapter = {
  platform: "codex",
  // One hook invocation is one logical turn and the delivery marker runs on
  // every one of them, so the SDK claims channel="hook" for these writes and
  // they enter L1-2's denominator. Whole-session hosts leave this unset.
  turnBoundary: "stop",
  taskBatching: true,
  envFile() {
    return process.env.EVERME_ENV_FILE_PATH || path4.join(os2.homedir(), ".codex", "everme.env");
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
    return readLastTurn(input?.transcriptPath, { diagnostic: (line) => console.error(line) });
  },
  readStoreBatches(input, options) {
    return readCodexStoreBatches(input, { ...options, diagnostic: (line) => console.error(line) });
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
