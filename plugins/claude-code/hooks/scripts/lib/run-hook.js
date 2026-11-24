import { spawn } from "node:child_process";
import { runHook } from "@everme/agent-sdk";
import { claudeCodeAdapter } from "./adapter.js";

// Claude Code cancels a SessionEnd hook that runs longer than 1.5 s
// (CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS), and the flush waits for the
// extraction, so the hook hands the flush to a detached copy of itself and
// returns.
const DETACHED_EVENTS = new Set(["SessionEnd"]);
const DETACHED_INPUT_ENV = "EVERME_CLAUDE_HOOK_INPUT";

export async function runClaudeCodeHook(event) {
  // Grok Build runs Claude Code's hooks for compatibility (settings.json
  // hooks, and Claude Code plugins a user enables in grok) and stamps
  // GROK_HOOK_EVENT on every hook process it spawns. Those sessions are
  // Grok's, captured by @everme/grok-build; taking them here would file them
  // as Claude Code and read a transcript in another format.
  if (process.env.GROK_HOOK_EVENT) return;
  const detachedInput = process.env[DETACHED_INPUT_ENV];
  const input = detachedInput ? parseJSON(detachedInput) : await readStdinJSON();
  // An input without a usable session id runs here, so its skip reason
  // still reaches stderr.
  if (!detachedInput && DETACHED_EVENTS.has(event) && claudeCodeAdapter.normalizeInput(input, event).sessionId) {
    spawn(process.execPath, [process.argv[1]], detachedSpawnOptions(input)).unref();
    return;
  }
  const output = await runHook(event, input, claudeCodeAdapter);
  if (output && Object.keys(output).length) process.stdout.write(JSON.stringify(output));
}

// A detached process on Windows gets a console window of its own unless it
// is hidden, so every session end would flash one.
export function detachedSpawnOptions(input, env = process.env) {
  return {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...env, [DETACHED_INPUT_ENV]: JSON.stringify(input) },
  };
}

async function readStdinJSON() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  if (!chunks.length) return {};
  return parseJSON(Buffer.concat(chunks).toString("utf8"));
}

function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
