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

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveHookKnobs } from "./hooks/knobs.js";
import { brandOf } from "./brand.js";

const DEFAULT_API_BASE = "https://api.everme.evermind.ai";
const API_PATH_PREFIX = "/api/v1";
const DEFAULT_LOCAL_GATEWAY = "http://127.0.0.1:18790";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export const TIMEOUT_MS = 30_000;
export const UPLOAD_TIMEOUT_MS = 120_000;

export function resolveConfig(host = {}) {
  const apiBase = trimSlash(host.apiBase || process.env.EVERME_API_BASE || DEFAULT_API_BASE);
  const memoryHome = host.memoryHome || process.env.EVERME_MEMORY_HOME || "";
  const hookKnobs = resolveHookKnobs({
    ...process.env,
    ...(host.flushEveryTurns === undefined ? {} : { EVERME_FLUSH_EVERY_TURNS: host.flushEveryTurns }),
    ...(host.flushMode === undefined ? {} : { EVERME_FLUSH_MODE: host.flushMode }),
    ...(host.injectTopK === undefined ? {} : { EVERME_INJECT_TOPK: host.injectTopK }),
    ...(host.injectProfile === undefined ? {} : { EVERME_INJECT_PROFILE: host.injectProfile }),
    ...(host.injectMinScore === undefined ? {} : { EVERME_INJECT_MIN_SCORE: host.injectMinScore }),
  }, { injectMinScore: routeInjectMinScore(memoryHome ? { EVERME_MEMORY_HOME: memoryHome } : process.env) });
  return {
    // baseUrl always includes /api/v1 so callers don't have to think about it.
    // Idempotent — works whether the env var was set with or without the prefix.
    baseUrl: apiBase.endsWith(API_PATH_PREFIX) ? apiBase : apiBase + API_PATH_PREFIX,
    agentId: host.agentId === undefined ? process.env.EVERME_AGENT_ID || "" : host.agentId,
    agentToken:
      host.agentToken === undefined ? process.env.EVERME_AGENT_TOKEN || "" : host.agentToken,
    topK: host.topK ?? 10,
    // Memory home and brand of this plugin instance. Both come from its own
    // credential file when two brands share one host process.
    memoryHome,
    brand: brandOf({ EVERME_BRAND: host.brand || process.env.EVERME_BRAND }),
    ...hookKnobs,
    // Deprecated: retained for the existing both-zero compatibility switch.
    flushMaxBytes: host.flushMaxBytes ?? 64 * 1024,
    // Client identity for X-EverMe-Client. Set by the hook runtime ("hook" +
    // adapter.version), memory-mcp ("mcp" + PKG_VERSION) and host-native
    // plugins; absent for bare callers, which the server files as unknown.
    ...(host.clientKind ? { clientKind: host.clientKind, clientVersion: host.clientVersion || "" } : {}),
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
      `${cfg.brand === "everos" ? "EverOS" : "EverMe"} plugin: missing ${missing.join(", ")}. ` +
        `Run \`evercli plugin install <agent>\` to provision the MCP entry.`,
    );
  }
}

function trimSlash(s) {
  return String(s || "").replace(/\/+$/, "");
}

/**
 * Read the device route EverMe Desktop writes for local memory. While it
 * exists, every request on this machine goes to the local memory gateway,
 * whatever the host's own config says. It fails closed: an unreadable or
 * altered file still routes to the default loopback gateway, so a broken
 * switch fails the request instead of sending memory to the cloud.
 *
 * Returns { baseUrl, injectMinScore? } for local, or null when the machine
 * uses the cloud.
 */
export function readDeviceRoute(env = process.env) {
  const home = env.EVERME_MEMORY_HOME || join(homedir(), ".everme", "memory");
  let raw;
  try {
    raw = readFileSync(join(home, "route.json"), "utf8");
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
    return { baseUrl: DEFAULT_LOCAL_GATEWAY + API_PATH_PREFIX };
  }
  let route;
  try {
    route = JSON.parse(raw);
  } catch {
    return { baseUrl: DEFAULT_LOCAL_GATEWAY + API_PATH_PREFIX };
  }
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    return { baseUrl: DEFAULT_LOCAL_GATEWAY + API_PATH_PREFIX };
  }
  if (route.mode !== "local") return null;
  const apiBase = isLoopbackBase(route.apiBase) ? trimSlash(route.apiBase) : DEFAULT_LOCAL_GATEWAY;
  const floor = route.injectMinScore;
  return {
    baseUrl: apiBase + API_PATH_PREFIX,
    ...(typeof floor === "number" && floor >= 0 && floor <= 1 ? { injectMinScore: floor } : {}),
  };
}

/**
 * The recall floor the route names for its backend, or undefined. An
 * open-source EverOS without a reranker scores on a lower scale than the
 * cloud, so evercli writes a lower floor into its route.
 */
export function routeInjectMinScore(env = process.env) {
  return readDeviceRoute(env)?.injectMinScore;
}

function isLoopbackBase(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname) && (u.pathname === "/" || u.pathname === "");
  } catch {
    return false;
  }
}
