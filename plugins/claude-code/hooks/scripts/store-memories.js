#!/usr/bin/env node
/**
 * Stop hook — fires after Claude finishes responding to a turn.
 * We read the transcript JSONL Claude Code wrote, extract the
 * just-completed raw turn, and POST it through the realtime gateway
 * (/mem/agent-memory). Runtime turns must not create /mem/sources.
 *
 * Hook contract (from Claude Code):
 *   stdin  = JSON { transcript_path, cwd, session_id, ... }
 *   stdout = empty (no need to surface anything to the user)
 *
 * Failure-mode: silent exit 0 — host must NEVER notice memory
 * persistence is broken. The gateway has its own retry loop on the
 * worker side, so a single dropped Stop event isn't catastrophic.
 */

process.on("uncaughtException", () => process.exit(0));
process.on("unhandledRejection", () => process.exit(0));

import { isConfigured, getConfig } from "./lib/config.js";
import {
  saveAgentMemory,
  EvermeError,
} from "./lib/api.js";
import { AGENT_MEMORY_ROLES } from "@everme/agent-sdk";
import { readTranscript, extractAgentMessages } from "./lib/transcript.js";
import { redactError, debug } from "./lib/redact.js";

const MIN_MESSAGES = 1;

async function main() {
  if (!isConfigured()) {
    debug("store", "skip: not configured");
    return process.exit(0);
  }
  const cfg = getConfig();
  if (cfg.authMode !== "evt" || !cfg.agentId) {
    debug("store", "skip: realtime agent memory requires EVERME_AGENT_TOKEN + EVERME_AGENT_ID");
    return process.exit(0);
  }
  const data = await readStdinJSON();
  const transcriptPath = data?.transcript_path;
  const sessionId = data?.session_id || "claude-code-session";
  if (!transcriptPath) {
    debug("store", "skip: no transcript_path");
    return process.exit(0);
  }

  const lines = await readTranscript(transcriptPath);
  const messages = extractAgentMessages(lines);
  // Only persist the LAST user/assistant pair from this Stop event so
  // we don't re-upload the entire history every turn — backend chains
  // versions per documentKey, so each call appends.
  const tail = lastTurn(messages);
  if (tail.length < MIN_MESSAGES) {
    debug("store", `skip: tail < ${MIN_MESSAGES} messages (got ${tail.length})`);
    return process.exit(0);
  }

  try {
    // Stop is the natural session-end signal for Claude Code; flush
    // so EverOS extracts episodes/profiles instead of letting
    // raw_messages accumulate indefinitely.
    const res = await saveAgentMemory({
      conversationId: sessionId,
      messages: tail,
      flush: true,
    });
    debug("store", `ok agent-memory status=${res?.status || "unknown"} flushed=${!!res?.flushed} messages=${res?.messageCount || tail.length}`);
  } catch (err) {
    // Visible single-line WARN — Stop hook is non-blocking by design,
    // but silently dropping every turn means a misconfigured machine
    // looks healthy while EverMe never receives a write. Surface
    // it once per Stop so persistent issues (401, network, schema
    // drift) bubble up without forcing EVERME_DEBUG=1.
    let reason;
    if (err instanceof EvermeError) {
      reason = `${err.type}: ${redactError(err.message)}`;
      debug("store", `failed type=${err.type}:`, redactError(err.message));
    } else {
      reason = redactError(err?.message || String(err));
      debug("store", "unexpected:", reason);
    }
    process.stderr.write(`EverMe store hook degraded: ${reason}\n`);
  }
  process.exit(0);
}

/**
 * Take the latest user prompt + assistant reply pair (plus any
 * tool/tool_result events that fall between them). The gateway's
 * realtime write API receives only this delta — uploading the whole
 * history would duplicate memories on every turn.
 */
function lastTurn(messages) {
  if (messages.length === 0) return [];
  // Walk backwards: take everything from the last `user` event
  // through the end. That captures user → tool... → assistant flow.
  let startIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === AGENT_MEMORY_ROLES.USER) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return messages;
  return messages.slice(startIdx);
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
