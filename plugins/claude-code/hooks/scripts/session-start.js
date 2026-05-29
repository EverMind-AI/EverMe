#!/usr/bin/env node
/**
 * SessionStart hook — surface a recent-context block when a new
 * Claude Code session begins. Helps the user (and Claude) pick up
 * where the previous session left off without manually pasting
 * context.
 *
 * Hook contract:
 *   stdin  = JSON { cwd, session_id, ... }
 *   stdout = JSON { systemMessage, hookSpecificOutput: { ..., additionalContext } }
 */

process.on("uncaughtException", () => process.exit(0));
process.on("unhandledRejection", () => process.exit(0));

import { isConfigured } from "./lib/config.js";
import { getContext } from "./lib/api.js";
import { redactError, debug } from "./lib/redact.js";
import { renderProfileBlock, profileItemCount } from "./lib/profile.js";

const TOP_K = 6;

async function main() {
  if (!isConfigured()) {
    debug("start", "skip: not configured");
    return process.exit(0);
  }
  await readStdinJSON(); // drain stdin (may be empty)

  let block = "";
  let count = 0;
  try {
    // Empty query — the gateway returns the user's profile snapshot.
    // Shape: { profile: {explicit_info, implicit_traits, ...} }
    const ctx = await getContext("", { topK: TOP_K });
    block = renderProfileBlock(ctx?.profile);
    count = profileItemCount(ctx?.profile);
  } catch (err) {
    debug("start", "context failed:", redactError(err?.message));
    return process.exit(0);
  }
  if (!block || count === 0) {
    debug("start", "no context");
    return process.exit(0);
  }

  const out = {
    systemMessage: `🧠 EverMe loaded ${count} memory ${count === 1 ? "item" : "items"} from past sessions`,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: block,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

async function readStdinJSON() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

main();
