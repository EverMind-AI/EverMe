/**
 * Resolve runtime config from env (set by `evercli plugin install`) plus
 * any host-supplied overrides (OpenClaw factoryConfig).
 *
 * Precedence (highest first):
 *   1. host config (factoryConfig from OpenClaw / explicit args from MCP)
 *   2. process.env (EVERME_API_BASE, EVERME_AGENT_ID, EVERME_AGENT_TOKEN)
 *   3. compiled defaults
 *
 * EVERME_AGENT_TOKEN is the only secret on this layer. It is held as a
 * string in memory and used for the Authorization: Bearer header — never
 * logged, echoed, or written to error messages.
 */

const DEFAULT_API_BASE = "https://api.everme.evermind.ai";
const API_PATH_PREFIX = "/api/v1";

export const TIMEOUT_MS = 30_000;
export const UPLOAD_TIMEOUT_MS = 120_000;

export function resolveConfig(host = {}) {
  const apiBase = trimSlash(host.apiBase || process.env.EVERME_API_BASE || DEFAULT_API_BASE);
  return {
    // baseUrl always includes /api/v1 so callers don't have to think about it.
    // Idempotent — works whether the env var was set with or without the prefix.
    baseUrl: apiBase.endsWith(API_PATH_PREFIX) ? apiBase : apiBase + API_PATH_PREFIX,
    agentId: host.agentId || process.env.EVERME_AGENT_ID || "",
    agentToken: host.agentToken || process.env.EVERME_AGENT_TOKEN || "",
    topK: host.topK ?? 5,
    // Setting EITHER to 0 disables that specific auto-flush trigger
    // but the OTHER trigger (and the buffer's hard RAM cap) still
    // produces uploads. Setting BOTH to 0 enters genuine "search-only"
    // mode: the buffer accumulates turns for ranking context but
    // never auto-uploads to /mem/sources. The hard cap then evicts
    // the OLDEST turns instead of flushing — bounded RAM, zero
    // backend writes. Explicit `buffer.flush()` / `dispose()` still
    // upload (the documented escape hatch).
    //
    // Default flushEveryTurns=1 (every turn): we observed empirically
    // that any larger value loses agent_case/agent_skill on short
    // sessions — sessions of 1-N turns never reach the flush threshold
    // so EverOS never runs extraction on them. Trading 5× the LLM
    // extract cost for "no extraction at all" is a bad bargain at
    // current usage levels. Hosts with high turn volume can override
    // upward via openclaw.plugin.json config when warranted.
    flushEveryTurns: host.flushEveryTurns ?? 1,
    flushMaxBytes: host.flushMaxBytes ?? 64 * 1024,
  };
}

/**
 * Validate the resolved config. Throws with a non-secret error message
 * (token presence checked, value not surfaced).
 */
export function assertConfigUsable(cfg) {
  const missing = [];
  if (!cfg.agentId) missing.push("EVERME_AGENT_ID");
  if (!cfg.agentToken) missing.push("EVERME_AGENT_TOKEN");
  if (missing.length) {
    throw new Error(
      `EverMe plugin: missing ${missing.join(", ")}. ` +
        `Run \`evercli plugin install <agent>\` to provision the MCP entry.`,
    );
  }
}

function trimSlash(s) {
  return String(s || "").replace(/\/+$/, "");
}
