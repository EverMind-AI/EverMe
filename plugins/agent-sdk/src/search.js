/**
 * Search wrappers around EverMe's memory endpoints.
 *
 * Two retrieval surfaces, picked by call site:
 *
 *   - searchMemory  — POST /mem/search, full-control body with query,
 *                      filters, top_k. Used by the MCP "mem_search" tool
 *                      and by anything that wants raw results.
 *   - getContext    — POST /mem/context, server-assembled context block
 *                      (the auto-prompt). Body accepts only an optional
 *                      { forceRefresh: bool } — agent is bound from the
 *                      MemAuth token, so query/topK/agentId are no longer
 *                      forwarded. Used for queryless profile snapshots
 *                      (Claude Code / Kimi Code SessionStart hooks);
 *                      per-turn recall goes through searchMemory instead.
 *
 * Both endpoints accept evt_ via Bearer (MemAuth + mem:search/mem:read).
 */

import { boundedDiagnostic, requestMeta } from "./client.js";
import { cacheSkillContent } from "./hooks/skill-cache.js";
import { filterSkillsByScore, PROFILE_MAX_CHARS, PROFILE_MAX_ITEMS } from "./prompt.js";

const noop = { info() {}, warn() {} };

// Mirror the backend's MaxSearchQueryRunes (server/internal/biz/memory/
// search.go): /mem/search rejects query > 1024 runes with ErrValidation.
// Callers hand us raw user prompts that can be huge pastes (a log dump, a
// whole file), so we clamp here — the single chokepoint to /mem/search —
// and every surface (MCP mem_search, OpenClaw assemble, Claude Code hook)
// stays under the limit instead of silently failing recall. We count JS
// string length (UTF-16 units), which is always >= the rune count, so a
// 1024-char slice can never exceed 1024 runes. Keep in sync with the Go
// constant.
export const QUERY_MAX_CHARS = 1024;

// Fallback page size when a caller omits topK. It deliberately stays at 10
// while per-turn auto-injection dropped to DEFAULT_INJECT_TOPK (hooks/knobs.js):
// searchMemory also backs the MCP explicit-retrieval tools, where the agent
// asks on purpose and picks its own count — a different problem from the
// every-turn injection budget.
export const DEFAULT_SEARCH_TOPK = 10;

// Host-local IANA zone. When a caller hands us a bare date with no offset we
// interpret it here instead of defaulting to UTC: the plugin runs on the
// user's machine, so this is simply the right answer, and an eight-hour slip
// is enough to move "yesterday" onto the wrong day.
function hostTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// A date, optionally with a wall-clock time, carrying no zone designator.
const NAIVE_ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/;
// The same shape but with an explicit Z / +-hh:mm — already unambiguous.
const ZONED_ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i;

const ZONE_PROBE_OPTS = {
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
};

// Minutes east of UTC that `timeZone` was on at `date`. Read back out of
// Intl rather than pulling in a date library: plugins/AGENTS.md forbids a
// new dependency for a local convenience.
function zoneOffsetMinutes(date, timeZone) {
  const at = {};
  for (const part of new Intl.DateTimeFormat("en-US", { timeZone, ...ZONE_PROBE_OPTS }).formatToParts(date)) {
    at[part.type] = part.value;
  }
  // Some ICU builds render midnight as hour 24 under hour12:false.
  const hour = Number(at.hour) % 24;
  const wall = Date.UTC(
    Number(at.year),
    Number(at.month) - 1,
    Number(at.day),
    hour,
    Number(at.minute),
    Number(at.second),
  );
  return (wall - date.getTime()) / 60000;
}

function pad(value, width = 2) {
  return String(Math.abs(value)).padStart(width, "0");
}

// Resolve a naive `YYYY-MM-DDTHH:mm:ss` wall clock in `timeZone` into an ISO
// string that carries that zone's offset. Two passes: the first guesses the
// instant from the wall clock, the second re-reads the offset at that instant
// so a DST transition inside the window still lands on the right side.
function zonedToISO(naive, timeZone) {
  const [datePart, timePart] = naive.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute, second] = timePart.split(":").map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const probe = new Date(wall);
  const rolled =
    Number.isNaN(wall) ||
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59;
  if (rolled) throw new RangeError(`invalid timestamp: ${naive}`);
  let instant = wall;
  for (let pass = 0; pass < 2; pass += 1) {
    instant = wall - zoneOffsetMinutes(new Date(instant), timeZone) * 60000;
  }
  const offset = zoneOffsetMinutes(new Date(instant), timeZone);
  const sign = offset < 0 ? "-" : "+";
  const offsetHours = Math.trunc(Math.abs(offset) / 60);
  const offsetMinutes = Math.abs(offset) % 60;
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${sign}${pad(offsetHours)}:${pad(offsetMinutes)}`;
}

/**
 * Normalise one model-authored timestamp into an ISO 8601 instant that
 * carries an explicit offset.
 *
 * A value that already names its zone (Z or +-hh:mm) is returned verbatim —
 * the caller was explicit and re-rendering it would only obscure what the
 * model asked for. A bare date (or date + wall time) is resolved against
 * `timeZone`, defaulting to the host's own zone. Anything else falls back to
 * Date parsing and throws RangeError when that fails, so a malformed bound
 * surfaces as a tool error instead of silently filtering the result set empty.
 *
 * @param {string} value
 * @param {string} [timeZone] IANA id; defaults to the host's zone
 * @returns {string} ISO 8601 instant, or "" for empty input
 */
export function normalizeInstant(value, timeZone = hostTimeZone()) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (ZONED_ISO.test(text)) {
    if (Number.isNaN(new Date(text.replace(" ", "T")).getTime())) {
      throw new RangeError(`invalid timestamp: ${text}`);
    }
    return text;
  }
  if (!NAIVE_ISO.test(text)) {
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) throw new RangeError(`invalid timestamp: ${text}`);
    return parsed.toISOString();
  }
  const [datePart, timePart = "00:00:00"] = text.replace(" ", "T").split("T");
  return zonedToISO(`${datePart}T${timePart.padEnd(8, ":00").slice(0, 8)}`, timeZone);
}

/**
 * Compile the flat startTime / endTime tool arguments into the gateway's
 * `filters.timestamp` operator map.
 *
 * Either bound may stand alone — that is a legal half-open interval — so the
 * ordering check only runs when both are present. Returns null when neither
 * was given, which is what keeps `filters` out of the request body entirely.
 *
 * @param {object} args { startTime?, endTime?, timeZone? }
 * @returns {{timestamp: {gte?: string, lte?: string}}|null}
 * @throws {RangeError} on an unparseable bound or a reversed interval
 */
export function buildTimestampFilter({ startTime, endTime, timeZone } = {}) {
  const ts = {};
  if (startTime) {
    const gte = normalizeInstant(startTime, timeZone);
    if (gte) ts.gte = gte;
  }
  if (endTime) {
    const lte = normalizeInstant(endTime, timeZone);
    if (lte) ts.lte = lte;
  }
  // Compare instants, not strings: the two bounds can legitimately carry
  // different offsets, and lexical order would then disagree with real order.
  if (ts.gte && ts.lte && Date.parse(ts.gte) > Date.parse(ts.lte)) {
    throw new RangeError("startTime must not be after endTime");
  }
  return Object.keys(ts).length ? { timestamp: ts } : null;
}

/**
 * @param {object} client createClient() result
 * @param {object} params { query, topK?, rankBy?, filters?, memoryTypes? }
 *                          — agent is bound from the MemAuth token, so
 *                          agentId is not forwarded. Use `filters` (server
 *                          accepts sessionId + a timestamp operator map) for
 *                          any narrowing; buildTimestampFilter() compiles the
 *                          MCP startTime / endTime arguments into it.
 *                          `memoryTypes` (optional) is forwarded as the
 *                          camelCase `memoryTypes` body field; subset of
 *                          ["episodic_memory","profile","raw_message",
 *                          "agent_memory"]. Omit to let EverMe expand to
 *                          the full set — the EverOS default of just the
 *                          first two silently drops raw_messages and
 *                          agent_memory.{cases,skills}, and the gateway
 *                          fixes that on omission.
 * @returns {Promise<{memories: Array, profiles: Array, rawMessages: Array, agentMemory: {cases: Array, skills: Array}}>}
 *
 * EverMe /mem/search returns episodes under `items` plus, when the
 * upstream surfaces them, parallel `profiles`, `rawMessages`, and
 * `agentMemory.{cases,skills}` arrays. We rename `items` → `memories`
 * at the SDK boundary so consumers see a single noun across sections.
 */
export async function searchMemory(client, params, log = noop) {
  const body = {
    query: String(params.query || "").slice(0, QUERY_MAX_CHARS),
    topK: params.topK ?? DEFAULT_SEARCH_TOPK,
    ...(params.rankBy ? { rankBy: params.rankBy } : {}),
    // The gateway reads `filters` (plural). This used to say `filter`, which
    // Go dropped silently as an unknown field — no caller narrowing has ever
    // reached /mem/search until now.
    ...(params.filters ? { filters: params.filters } : {}),
    ...(Array.isArray(params.memoryTypes) && params.memoryTypes.length
      ? { memoryTypes: params.memoryTypes }
      : {}),
  };
  const { result: res, requestId } = await requestMeta(client, "POST", "/mem/search", body);
  const memoryCount = Array.isArray(res?.items) ? res.items.length : 0;
  const profileCount = Array.isArray(res?.profiles) ? res.profiles.length : 0;
  const rawMessageCount = Array.isArray(res?.rawMessages) ? res.rawMessages.length : 0;
  const caseCount = Array.isArray(res?.agentMemory?.cases) ? res.agentMemory.cases.length : 0;
  const skillCount = Array.isArray(res?.agentMemory?.skills) ? res.agentMemory.skills.length : 0;
  log.info?.(`[everme] memory-search stage=complete result=success queryChars=${body.query.length} topK=${body.topK} memories=${memoryCount} profiles=${profileCount} rawMessages=${rawMessageCount} cases=${caseCount} skills=${skillCount} requestId=${boundedDiagnostic(requestId, 128)}`);
  // Every host's retrieval passes through here, and the skill bodies are in
  // this response and nowhere else reachable — the gateway has no get-by-id
  // and EverOS cannot filter on id. Persisting them here is what lets a hook
  // process populate a cache an MCP process reads back later. Only rows that
  // clear the render threshold are kept: the others never reach a prompt, so
  // their ids are never quotable. Best-effort by construction — cacheSkillContent
  // swallows its own failures so recall cannot fail over a cache write.
  //
  // Gated on the same flag that gates rendering: a host whose prompt never
  // carries a skill id can never ask for a body, so caching one would leave
  // files on disk that nothing can ever reference.
  if (params.skillFetch === true) {
    await cacheSkillContent(filterSkillsByScore(res?.agentMemory?.skills));
  }
  return {
    memories: res?.items ?? [],
    profiles: res?.profiles ?? [],
    rawMessages: res?.rawMessages ?? [],
    agentMemory: res?.agentMemory ?? { cases: [], skills: [] },
    requestId,
  };
}

/**
 * @param {object} client
 * @param {string} _query  unused — kept for call-site stability; the server
 *                          binds the agent via auth and assembles the block
 *                          without a query.
 * @param {object} opts { forceRefresh? }
 * @returns {Promise<{context: string, memoryCount: number}>}
 */
export async function getContext(client, _query, opts = {}, log = noop) {
  const body = opts.forceRefresh ? { forceRefresh: true } : {};
  const { result: res, requestId } = await requestMeta(client, "POST", "/mem/context", body);
  log.info?.(`[everme] memory-context stage=complete result=success forceRefresh=${!!opts.forceRefresh} requestId=${boundedDiagnostic(requestId, 128)}`);
  if (typeof res?.context === "string" && res.context) {
    return { context: res.context, memoryCount: res.memoryCount ?? estimateCount(res), requestId };
  }
  // EverMe /mem/context returns a structured `profile` (explicit_info +
  // implicit_traits) rather than a pre-rendered block; render it here so
  // the engine can inject it as systemPromptAddition without a /mem/search
  // fallback round-trip.
  if (res?.profile) {
    const rendered = renderProfile(res.profile);
    if (rendered) {
      return { context: rendered, memoryCount: estimateProfileCount(res.profile), requestId };
    }
  }
  return { context: "", memoryCount: estimateCount(res), requestId };
}

function renderProfile(profile) {
  if (!profile || typeof profile !== "object") return "";
  // Same budgets as the SessionStart block — see PROFILE_MAX_ITEMS.
  const explicit = (profile.explicit_info || []).slice(0, PROFILE_MAX_ITEMS);
  const implicit = (profile.implicit_traits || []).slice(
    0,
    Math.max(0, PROFILE_MAX_ITEMS - explicit.length),
  );
  const lines = [];
  for (const row of explicit) {
    const cat = row.category ? `[${row.category}] ` : "";
    if (row.description) lines.push(`- ${cat}${oneLineText(row.description)}`);
  }
  for (const row of implicit) {
    const t = row.trait ? `${row.trait}: ` : "";
    if (row.description) lines.push(`- ${t}${oneLineText(row.description)}`);
  }
  if (!lines.length) return "";
  return "```memory\n## Relevant memory\n" + lines.join("\n") + "\n```";
}

/**
 * Drop episodes that fall below the recall floor.
 *
 * Shared by every per-turn auto-injection path (the UserPromptSubmit hook
 * and OpenClaw's ContextEngine.assemble) so the two cannot drift — they did
 * once, and OpenClaw silently ran with no floor at all.
 *
 * Episodes always come back hybrid-ranked, and that scorer is a calibrated
 * logistic probability bounded to (0.0077, 0.805] — a literal 0 cannot
 * occur, so admitting one would only ever let an unranked row into the
 * context. A missing score still passes: that is a field-absent defence,
 * not a policy.
 *
 * @param {Array} memories  rows from searchMemory().memories
 * @param {number} minScore recall floor (config.injectMinScore)
 * @returns {Array} the surviving rows, order preserved
 */
export function filterEpisodesByScore(memories, minScore) {
  return (memories || []).filter((memory) => {
    const score = memory?.score ?? memory?.relevanceScore;
    return score == null || score >= minScore;
  });
}

function estimateProfileCount(profile) {
  if (!profile) return 0;
  return (profile.explicit_info?.length || 0) + (profile.implicit_traits?.length || 0);
}

function oneLineText(s) {
  return String(s).replace(/\s+/g, " ").trim().slice(0, PROFILE_MAX_CHARS);
}

function estimateCount(res) {
  if (!res || typeof res !== "object") return 0;
  const arr = res.items || [];
  return Array.isArray(arr) ? arr.length : 0;
}
