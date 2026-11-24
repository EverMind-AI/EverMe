#!/usr/bin/env node

import { spawn } from "node:child_process";
import { redactError, runHook } from "@everme/agent-sdk";
import { cursorAdapter } from "../src/adapter.js";

// cursor-agent -p ends its hooks when it exits, so a sessionEnd hook that
// stores the turn and then waits for the flush is cut off between the two:
// the turn is never counted and the session is never flushed. The hook hands
// sessionEnd to a detached copy of itself and returns.
const DETACHED_EVENTS = new Set(["sessionEnd"]);
const DETACHED_INPUT_ENV = "EVERME_CURSOR_HOOK_INPUT";

main().catch((error) => {
  const reason = redactError(error).replace(/\s+/g, " ").trim();
  process.stderr.write(`EverMe Cursor hook degraded: ${reason}\n`);
  process.exitCode = 0;
});

async function main() {
  const [, , command, event] = process.argv;
  if (command !== "hook" || !event) return;
  // Grok Build loads ~/.cursor/hooks.json for compatibility and stamps
  // GROK_HOOK_EVENT on every hook process it spawns. Those sessions are
  // Grok's, captured by @everme/grok-build.
  if (process.env.GROK_HOOK_EVENT) return;
  const detachedInput = process.env[DETACHED_INPUT_ENV];
  const input = detachedInput ? parseJSON(detachedInput) : await readStdinJSON();
  // An input without a usable session id runs here, so its skip reason
  // still reaches stderr.
  if (!detachedInput && DETACHED_EVENTS.has(event) && cursorAdapter.normalizeInput(input, event).sessionId) {
    spawn(process.execPath, process.argv.slice(1), detachedSpawnOptions(input)).unref();
    return;
  }
  const output = await runHook(event, input, cursorAdapter, { detached: Boolean(detachedInput) });
  if (output && Object.keys(output).length) {
    process.stdout.write(JSON.stringify(output));
  }
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
