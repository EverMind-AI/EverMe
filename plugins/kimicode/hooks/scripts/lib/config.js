/**
 * Plugin config loader.
 *
 * Source precedence:
 *
 *   For EVERME_AGENT_TOKEN and EVERME_AGENT_ID — the per-machine
 *   credentials evercli rotates — `~/.kimi-code/everme.env` always wins.
 *   evercli is the canonical owner of these values; if anything else
 *   (a stale config mcp.env block, a leftover shell var) has a
 *   different value, it's stale and the freshly-rotated evt must win.
 *
 *   For every other EVERME_* (EVERME_API_KEY for emk-mode debugging,
 *   EVERME_API_BASE for self-hosted EverMe, …) process.env still wins:
 *   users may legitimately want to override these from a shell or from
 *   Kimi Code's mcp .env block, and evercli does not own them.
 *
 *   Compiled defaults (api.everme.evermind.ai, no token) sit at the bottom.
 *
 * Auth modes (mutually exclusive, both wire-compatible):
 *   evt — set EVERME_AGENT_TOKEN (per-machine token from evercli)
 *   emk — set EVERME_API_KEY     (account-level, from EverMe Web UI)
 *
 * If neither is set the plugin runs in disabled-mode: hooks short-
 * circuit silently so the host (Kimi Code) is never blocked.
 *
 * NOTE (Kimi Code): the env-file lives at $KIMI_CODE_HOME/everme.env
 * (default ~/.kimi-code/everme.env). Kimi Code's mcpServers.env cannot
 * carry per-user secrets (no ${VAR} expansion), so the MCP server + the
 * hooks both read creds from this file at runtime.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveConfig as sdkResolveConfig } from "@everme/agent-sdk";

// Resolve the Kimi Code home directory ($KIMI_CODE_HOME, default
// ~/.kimi-code). The hook process always has KIMI_CODE_HOME in env, but
// the MCP server (or a manual invocation) may not, so we fall back.
function kimiCodeHome() {
  return process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code");
}

// Env-file location. EVERME_ENV_FILE_PATH overrides for tests so they
// don't get polluted by a real file on the developer's box.
function evermeEnvFilePath() {
  return process.env.EVERME_ENV_FILE_PATH || join(kimiCodeHome(), "everme.env");
}

let cached = null;
let envFileLoaded = false;

// Keys that evercli rotates per machine. For these, the env file is
// the canonical source — if process.env carries a different value
// (stale config mcp.env block, leftover shell export from a
// previous account), the env file's value MUST overwrite it. Without
// this the freshly-rotated evt could be shadowed by a stale token,
// leaving every memory call 401.
const EVERME_ROTATED_KEYS = new Set([
  "EVERME_AGENT_TOKEN",
  "EVERME_AGENT_ID",
]);

/**
 * Load $KIMI_CODE_HOME/everme.env (KEY=value lines) into process.env.
 * Idempotent — runs once per process.
 *
 * For EVERME_ROTATED_KEYS the env file always wins. For everything
 * else (EVERME_API_KEY, EVERME_API_BASE, …) process.env wins so users
 * can override via shell or mcp .env block.
 *
 * This is the path evercli uses to hand the freshly-minted evt to the
 * plugin without editing the user's shell profile (which is brittle:
 * profile name varies by shell, and a user might run `kimi` from a
 * non-interactive shell that doesn't load .zshrc).
 */
function loadEnvFile() {
  if (envFileLoaded) return;
  envFileLoaded = true;
  const path = evermeEnvFilePath();
  if (!existsSync(path)) return;
  try {
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 1) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      // Tolerate quoted values (single or double).
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (EVERME_ROTATED_KEYS.has(k)) {
        // evercli owns this key — env file always wins.
        process.env[k] = v;
      } else if (!process.env[k]) {
        // user-overridable key — fill gap only.
        process.env[k] = v;
      }
    }
  } catch {
    /* unreadable file is not fatal — plugin runs disabled */
  }
}

export function getConfig() {
  if (cached) return cached;
  loadEnvFile();

  const agentToken = process.env.EVERME_AGENT_TOKEN || process.env.EVERME_API_KEY || "";
  const authMode = process.env.EVERME_AGENT_TOKEN
    ? "evt"
    : process.env.EVERME_API_KEY
    ? "emk"
    : "none";

  const sdkCfg = sdkResolveConfig({
    apiBase: process.env.EVERME_API_BASE,
    agentId: process.env.EVERME_AGENT_ID,
    agentToken,
    topK: 5,
  });

  cached = {
    ...sdkCfg,
    authMode,
    isConfigured: !!agentToken,
  };
  return cached;
}

export function isConfigured() {
  return getConfig().isConfigured;
}

export function _resetCache() {
  cached = null;
  envFileLoaded = false;
}
