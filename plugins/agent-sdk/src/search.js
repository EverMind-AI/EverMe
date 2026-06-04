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
 *                      forwarded. Used by the OpenClaw engine's assemble().
 *
 * Both endpoints accept evt_ via Bearer (MemAuth + mem:search/mem:read).
 */

const noop = { info() {}, warn() {} };

// Mirror the backend's max search-query limit: /mem/search rejects a
// query longer than 1024 runes with a validation error.
// Callers hand us raw user prompts that can be huge pastes (a log dump, a
// whole file), so we clamp here — the single chokepoint to /mem/search —
// and every surface (MCP mem_search, OpenClaw assemble, Claude Code hook)
// stays under the limit instead of silently failing recall. We count JS
// string length (UTF-16 units), which is always >= the rune count, so a
// 1024-char slice can never exceed 1024 runes. Keep in sync with the Go
// constant.
export const QUERY_MAX_CHARS = 1024;

/**
 * @param {object} client createClient() result
 * @param {object} params { query, topK?, rankBy?, filter?, memoryTypes? }
 *                          — agent is bound from the MemAuth token, so
 *                          agentId is not forwarded. Use `filter` (server
 *                          accepts an opaque map) for any narrowing.
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
    topK: params.topK ?? 5,
    ...(params.rankBy ? { rankBy: params.rankBy } : {}),
    ...(params.filter ? { filter: params.filter } : {}),
    ...(Array.isArray(params.memoryTypes) && params.memoryTypes.length
      ? { memoryTypes: params.memoryTypes }
      : {}),
  };
  log.info?.(`[everme] POST /mem/search topK=${body.topK} q="${truncate(body.query, 60)}"`);
  const res = await client.request("POST", "/mem/search", body);
  return {
    memories: res?.items ?? [],
    profiles: res?.profiles ?? [],
    rawMessages: res?.rawMessages ?? [],
    agentMemory: res?.agentMemory ?? { cases: [], skills: [] },
    requestId: res?.requestId,
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
  log.info?.(`[everme] POST /mem/context forceRefresh=${!!opts.forceRefresh}`);
  const res = await client.request("POST", "/mem/context", body);
  if (typeof res?.context === "string" && res.context) {
    return { context: res.context, memoryCount: res.memoryCount ?? estimateCount(res) };
  }
  // EverMe /mem/context returns a structured `profile` (explicit_info +
  // implicit_traits) rather than a pre-rendered block; render it here so
  // the engine can inject it as systemPromptAddition without a /mem/search
  // fallback round-trip.
  if (res?.profile) {
    const rendered = renderProfile(res.profile);
    if (rendered) {
      return { context: rendered, memoryCount: estimateProfileCount(res.profile) };
    }
  }
  return { context: "", memoryCount: estimateCount(res) };
}

function renderProfile(profile) {
  if (!profile || typeof profile !== "object") return "";
  const lines = [];
  for (const row of profile.explicit_info || []) {
    const cat = row.category ? `[${row.category}] ` : "";
    if (row.description) lines.push(`- ${cat}${oneLineText(row.description)}`);
  }
  for (const row of profile.implicit_traits || []) {
    const t = row.trait ? `${row.trait}: ` : "";
    if (row.description) lines.push(`- ${t}${oneLineText(row.description)}`);
  }
  if (!lines.length) return "";
  return "```memory\n## Relevant memory\n" + lines.join("\n") + "\n```";
}

function estimateProfileCount(profile) {
  if (!profile) return 0;
  return (profile.explicit_info?.length || 0) + (profile.implicit_traits?.length || 0);
}

function oneLineText(s) {
  return String(s).replace(/\s+/g, " ").trim().slice(0, 280);
}

function estimateCount(res) {
  if (!res || typeof res !== "object") return 0;
  const arr = res.items || [];
  return Array.isArray(arr) ? arr.length : 0;
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}
