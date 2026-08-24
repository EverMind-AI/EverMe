/**
 * Kimi Code transcript reader.
 *
 * Unlike Claude Code, Kimi Code hooks do NOT receive a
 * transcript path on stdin. The transcript lives at a deterministic
 * location keyed by the working directory + session id:
 *
 *   $KIMI_CODE_HOME/sessions/<workDirKey>/<session_id>/agents/main/wire.jsonl
 *
 * where
 *   KIMI_CODE_HOME  defaults to ~/.kimi-code
 *   <workDirKey>    = wd_<slug>_<first-12-hex-of-sha256(cwd)>
 *   <session_id>    = the stdin `session_id` (already like session_<uuid>)
 *
 * wire.jsonl is a JSONL event stream (timestamps are epoch ms in the
 * field `time`). We translate the events into the EverMe agent-memory
 * message shape:
 *
 *   { role:"user"|"assistant"|"tool", timestamp, content, toolCalls?, toolCallId? }
 *
 * Event mapping (confirmed from real tool-running sessions):
 *   - context.append_message, message.role=="user", origin.kind=="user"
 *     (or no origin)                      -> a user message.
 *     message.content is [{type:"text", text}] blocks. DROP any non-user
 *     origin: injection (recall/system reminders), skill_activation, etc.
 *   - context.append_loop_event, event.type=="content.part",
 *     event.part.type=="text"             -> assistant text; aggregate
 *     by event.turnId + event.step, flush at event.type=="step.end".
 *     DROP part.type=="think".
 *   - context.append_loop_event, event.type=="tool.call"
 *     ({toolCallId,name,args}) -> assistant message with a toolCalls entry
 *     (args is an object -> JSON-stringified). Pending text is flushed
 *     first so order is text -> call -> result.
 *   - context.append_loop_event, event.type=="tool.result"
 *     ({toolCallId|parentUuid, result.output}) -> a tool message.
 *
 * "last turn" = from the last user message through end of stream
 * (mirrors claude-code store-memories.js lastTurn).
 *
 * Failure-mode: every error returns [] — a hook must never
 * block the host.
 */

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_MEMORY_ROLES, AGENT_MEMORY_TOOL_CALL_TYPES } from "@everme/agent-sdk";

const READ_RETRIES = 5;
const RETRY_DELAY_MS = 100;

function kimiCodeHome() {
  return process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code");
}

/**
 * Build the wd_<slug>_<hash12> work-dir key from an absolute cwd.
 *
 * <slug>  : the cwd basename, lowercased, with non-alphanumerics
 *           collapsed to single underscores (best-effort — only the
 *           hash is load-bearing for uniqueness).
 * <hash12>: first 12 hex chars of sha256(cwd).
 */
export function workDirKey(cwd) {
  const dir = String(cwd || "");
  const base = dir.split("/").filter(Boolean).pop() || "root";
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "root";
  const hash12 = createHash("sha256").update(dir).digest("hex").slice(0, 12);
  return `wd_${slug}_${hash12}`;
}

/**
 * First 12 hex of sha256(cwd) — the load-bearing, drift-proof half of the
 * bucket dir name. Kimi's encodeWorkDirKey and our workDirKey agree on this
 * hash even when their slug rules disagree (hyphens/dots), so it uniquely
 * identifies a workdir's bucket regardless of slug.
 */
function workDirHash(cwd) {
  return createHash("sha256").update(String(cwd || "")).digest("hex").slice(0, 12);
}

/**
 * Resolve the absolute sessions/<bucket> directory for a cwd. Kimi names it
 * `wd_<slug>_<hash12>`. We try the slug workDirKey produces first (fast, and
 * correct for purely alphanumeric basenames), then fall back to locating the
 * bucket by its `_<hash12>` suffix. The fallback is what makes this robust to
 * the slug drift between Kimi's encodeWorkDirKey (keeps hyphens/dots) and ours:
 * matching on the hash never misses. Returns the expected (possibly missing)
 * path when nothing matches, so the caller's existsSync degrades to "no work".
 */
function resolveWorkDir(cwd) {
  const sessionsRoot = join(kimiCodeHome(), "sessions");
  const expected = join(sessionsRoot, workDirKey(cwd));
  if (existsSync(expected)) return expected;
  const suffix = "_" + workDirHash(cwd);
  let entries;
  try {
    entries = readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return expected;
  }
  for (const ent of entries) {
    if (ent.isDirectory() && ent.name.endsWith(suffix)) {
      return join(sessionsRoot, ent.name);
    }
  }
  return expected;
}

/**
 * Compute the absolute wire.jsonl path for a session.
 */
export function wirePath({ sessionId, cwd }) {
  return join(
    resolveWorkDir(cwd),
    String(sessionId || ""),
    "agents",
    "main",
    "wire.jsonl",
  );
}

/**
 * Read wire.jsonl with a small retry budget — a boundary hook can fire
 * before Kimi Code has flushed the final event. Returns the raw lines
 * (strings), or [] if unreadable.
 */
async function readWireLines(path) {
  if (!path || !existsSync(path)) return [];
  for (let i = 0; i < READ_RETRIES; i++) {
    let raw;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT" && i < READ_RETRIES - 1) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      return [];
    }
    const lines = raw.trim().split("\n").filter(Boolean);
    if (lines.length === 0) {
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    return lines;
  }
  return [];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Parse wire.jsonl lines into the EverMe agent-memory message sequence.
 * Robust to unknown event kinds — only the recognised events are
 * consumed, everything else is skipped.
 */
export function extractAgentMessages(lines) {
  const messages = [];
  // Assistant text is streamed as many content.part events; aggregate
  // per (turnId, step) and flush on step.end. Keyed map preserves the
  // first-seen timestamp for the flushed message.
  const pending = new Map(); // key -> { parts:[], timestamp }

  const keyFor = (ev) => `${ev?.turnId ?? ""}::${ev?.step ?? ""}`;
  const flushPending = (key) => {
    const slot = pending.get(key);
    if (!slot) return;
    pending.delete(key);
    const content = slot.parts.join("");
    if (content) {
      messages.push({
        role: AGENT_MEMORY_ROLES.ASSISTANT,
        timestamp: slot.timestamp,
        content,
      });
    }
  };

  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const timestamp = normalizeTimestamp(row?.time);
    const type = row?.type;

    if (type === "context.append_message") {
      const m = row?.message;
      if (!m || typeof m !== "object") continue;
      if (m.role !== AGENT_MEMORY_ROLES.USER) continue;
      // Keep only genuine user input: origin.kind=="user" (or no origin).
      // Drop every system-injected pseudo-user message — injection (recall
      // blocks / system reminders), skill_activation (injected skill text),
      // and any other non-user origin.
      const okind = m?.origin?.kind;
      if (okind && okind !== "user") continue;
      const text = textFromContent(m.content);
      if (text) {
        messages.push({ role: AGENT_MEMORY_ROLES.USER, timestamp, content: text });
      }
      continue;
    }

    if (type === "context.append_loop_event") {
      const ev = row?.event;
      if (!ev || typeof ev !== "object") continue;
      if (ev.type === "content.part") {
        const part = ev.part;
        if (!part || typeof part !== "object") continue;
        if (part.type === "think") continue; // drop chain-of-thought
        if (part.type !== "text") continue;
        const text = typeof part.text === "string" ? part.text : "";
        if (!text) continue;
        const key = keyFor(ev);
        const slot = pending.get(key) || { parts: [], timestamp };
        slot.parts.push(text);
        pending.set(key, slot);
      } else if (ev.type === "tool.call") {
        // Flush any assistant preamble text for this step first so order is
        // text -> tool call -> tool result.
        flushPending(keyFor(ev));
        const name = ev.name;
        if (!name) continue;
        const args = ev.args ?? {};
        messages.push({
          role: AGENT_MEMORY_ROLES.ASSISTANT,
          timestamp,
          toolCalls: [{
            id: ev.toolCallId || ev.uuid || `kimi_tool_${timestamp}`,
            type: AGENT_MEMORY_TOOL_CALL_TYPES.FUNCTION,
            name,
            arguments: typeof args === "string" ? args : safeJsonStringify(args),
          }],
        });
      } else if (ev.type === "tool.result") {
        const id = ev.toolCallId || ev.parentUuid;
        if (!id) continue;
        const output = ev?.result?.output;
        const content = typeof output === "string" ? output : safeJsonStringify(output ?? "");
        messages.push({
          role: AGENT_MEMORY_ROLES.TOOL,
          timestamp,
          content: content || "tool result",
          toolCallId: id,
        });
      } else if (ev.type === "step.end") {
        flushPending(keyFor(ev));
      }
      continue;
    }
  }

  // Flush any assistant text that never saw an explicit step.end (the
  // stream can be cut at the tail when Stop fires mid-flush).
  for (const key of Array.from(pending.keys())) {
    flushPending(key);
  }

  return messages;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (typeof b === "string") return b;
      if (b?.type === "text" && typeof b.text === "string") return b.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeTimestamp(ts) {
  if (typeof ts === "number" && Number.isFinite(ts)) {
    return ts > 10_000_000_000 ? Math.trunc(ts) : Math.trunc(ts * 1000);
  }
  const parsed = Date.parse(ts);
  if (Number.isFinite(parsed)) return parsed;
  return Date.now();
}

function safeJsonStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Take everything from the last user message through the end of the stream
 * (user -> tool... -> assistant). Mirrors claude-code store-memories.js
 * lastTurn. Retained as a utility (exported via readLastTurn); kimicode's
 * SessionEnd handler persists the WHOLE session via readSession rather than a
 * per-turn delta, so this is no longer on the write path.
 */
export function lastTurn(messages) {
  if (messages.length === 0) return [];
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

/**
 * High-level entry: locate wire.jsonl for {sessionId, cwd}, parse it,
 * and return just the last turn's messages. Returns [] on any failure.
 */
export async function readLastTurn({ sessionId, cwd }) {
  const path = wirePath({ sessionId, cwd });
  const lines = await readWireLines(path);
  if (lines.length === 0) return [];
  const messages = extractAgentMessages(lines);
  return lastTurn(messages);
}

/**
 * High-level entry: locate wire.jsonl for {sessionId, cwd}, parse it, and
 * return the FULL session (every turn). The SessionEnd hook uploads this whole
 * session in one flush so the backend has the coherent multi-turn context that
 * episodic-memory extraction needs. Returns [] on any failure.
 */
export async function readSession({ sessionId, cwd }) {
  const path = wirePath({ sessionId, cwd });
  const lines = await readWireLines(path);
  if (lines.length === 0) return [];
  return extractAgentMessages(lines);
}
