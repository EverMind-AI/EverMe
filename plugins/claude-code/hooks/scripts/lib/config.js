/**
 * Plugin config loader.
 *
 * Source precedence:
 *
 *   For EVERME_AGENT_TOKEN and EVERME_AGENT_ID — the per-machine
 *   credentials evercli rotates — `~/.claude/everme.env` always wins.
 *   evercli is the canonical owner of these values; if anything else
 *   (a stale .claude.json mcp.env block, a leftover shell var) has a
 *   different value, it's stale and the freshly-rotated evt must win.
 *
 *   For every other EVERME_* (EVERME_API_KEY for emk-mode debugging,
 *   EVERME_API_BASE for self-hosted EverMe, …) process.env still wins:
 *   users may legitimately want to override these from a shell or from
 *   Claude Code's mcp .env block, and evercli does not own them.
 *
 *   Compiled defaults (api.everme.evermind.ai, no token) sit at the bottom.
 *
 * Auth modes (mutually exclusive, both wire-compatible):
 *   evt — set EVERME_AGENT_TOKEN (per-machine token from evercli)
 *   emk — set EVERME_API_KEY     (account-level, from EverMe Web UI)
 *
 * If neither is set the plugin runs in disabled-mode: hooks short-
 * circuit silently so the host (Claude Code) is never blocked.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveConfig as sdkResolveConfig } from "@everme/agent-sdk";

// Env-file location. EVERME_ENV_FILE_PATH overrides for tests so they
// don't get polluted by a real file on the developer's box.
function evermeEnvFilePath() {
  return process.env.EVERME_ENV_FILE_PATH || join(homedir(), ".claude", "everme.env");
}

let cached = null;
let envFileLoaded = false;

// Keys that evercli rotates per machine. For these, the env file is
// the canonical source — if process.env carries a different value
// (stale .claude.json mcp.env block, leftover shell export from a
// previous account), the env file's value MUST overwrite it. Without
// this the freshly-rotated evt could be shadowed by a stale token,
// leaving every memory call 401.
const EVERME_ROTATED_KEYS = new Set([
  "EVERME_AGENT_TOKEN",
  "EVERME_AGENT_ID",
]);

/**
 * Load ~/.claude/everme.env (KEY=value lines) into process.env.
 * Idempotent — runs once per process.
 *
 * For EVERME_ROTATED_KEYS the env file always wins. For everything
 * else (EVERME_API_KEY, EVERME_API_BASE, …) process.env wins so users
 * can override via shell or mcp .env block.
 *
 * This is the path evercli uses to hand the freshly-minted evt to the
 * plugin without editing the user's shell profile (which is brittle:
 * profile name varies by shell, and a user might run `claude` from a
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
