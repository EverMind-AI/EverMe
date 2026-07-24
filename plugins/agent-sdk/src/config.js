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

import { resolveHookKnobs } from "./hooks/knobs.js";

const DEFAULT_API_BASE = "https://api.everme.evermind.ai";
const API_PATH_PREFIX = "/api/v1";

export const TIMEOUT_MS = 30_000;
export const UPLOAD_TIMEOUT_MS = 120_000;

export function resolveConfig(host = {}) {
  const apiBase = trimSlash(host.apiBase || process.env.EVERME_API_BASE || DEFAULT_API_BASE);
  const hookKnobs = resolveHookKnobs({
    ...process.env,
    ...(host.flushEveryTurns === undefined ? {} : { EVERME_FLUSH_EVERY_TURNS: host.flushEveryTurns }),
    ...(host.flushMode === undefined ? {} : { EVERME_FLUSH_MODE: host.flushMode }),
    ...(host.injectTopK === undefined ? {} : { EVERME_INJECT_TOPK: host.injectTopK }),
    ...(host.injectProfile === undefined ? {} : { EVERME_INJECT_PROFILE: host.injectProfile }),
    ...(host.injectMinScore === undefined ? {} : { EVERME_INJECT_MIN_SCORE: host.injectMinScore }),
  });
  return {
    // baseUrl always includes /api/v1 so callers don't have to think about it.
    // Idempotent — works whether the env var was set with or without the prefix.
    baseUrl: apiBase.endsWith(API_PATH_PREFIX) ? apiBase : apiBase + API_PATH_PREFIX,
    agentId: host.agentId === undefined ? process.env.EVERME_AGENT_ID || "" : host.agentId,
    agentToken:
      host.agentToken === undefined ? process.env.EVERME_AGENT_TOKEN || "" : host.agentToken,
    topK: host.topK ?? 10,
    ...hookKnobs,
    // Deprecated: retained for the existing both-zero compatibility switch.
    flushMaxBytes: host.flushMaxBytes ?? 64 * 1024,
  };
}

/**
 * Validate the resolved config. Throws with a non-secret error message
 * (token presence checked, value not surfaced).
 */
export function assertConfigUsable(cfg, { requireAgentId = true } = {}) {
  const missing = [];
  if (requireAgentId && !cfg.agentId) missing.push("EVERME_AGENT_ID");
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
