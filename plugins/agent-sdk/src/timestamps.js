/**
 * Stable fallback timestamps for messages the host sent without one.
 *
 * EverOS dedups raw messages by md5(app, project, session, sender, timestamp,
 * role, content). The SDK used to fill a missing timestamp with
 * `Date.now() + i` at send time, so every retry of the same turn carried new
 * timestamps, new message ids, and landed in EverOS a second time (dev, 48
 * retried pairs between 2026-10-27 and 2026-10-28). A fallback is now assigned
 * the first time a message is seen and reused on every later send of it, in
 * this process or another one.
 *
 * A message is identified without its timestamp:
 * - by `nativeId` when the adapter passes one;
 * - otherwise by its position inside its turn segment plus a digest of the
 *   whole segment. A segment starts at a user message, so a retry that also
 *   carries an earlier turn (a recovered batch plus the new turn) still finds
 *   the earlier turn's entries. Two segments that are identical message for
 *   message map to the same entries; EverOS then keeps one copy of that turn,
 *   which only loses an exact repeat.
 *
 * Host timestamps are never changed, and a send whose messages all carry
 * one never touches the ledger.
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { acquireLock, DEFAULT_STATE_DIR } from "./hooks/state.js";

const LEDGER_DIR = "timestamps";
const LEDGER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const LEDGER_MAX_ENTRIES = 4096;
// The ledger lock guards one read-modify-write of a small file. A holder that
// takes longer is wedged; the caller then sends with fresh fallbacks rather
// than stall the upload.
const LEDGER_LOCK_WAIT_MS = 2_000;
const MEMORY_MAX_CONVERSATIONS = 256;

/**
 * Host timestamp in epoch ms, or null when the host did not supply one.
 * Seconds are scaled to milliseconds, as everywhere else in the SDK.
 */
export function hostTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.trunc(value) : Math.trunc(value * 1000);
  }
  if (value == null || value === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Fallback timestamp for each message, or undefined where the host supplied
 * its own. Assignment order follows the messages, so a turn stays in order.
 */
export async function resolveFallbackTimestamps({ conversationId, messages, ledger, now = Date.now() }) {
  const out = new Array(messages.length).fill(undefined);
  const host = messages.map((message) => hostTimestamp(message?.timestamp));
  if (host.every((value) => value !== null)) return out;
  const keys = fallbackKeys(conversationId, messages);
  await ledger.withConversation(conversationId, (entries) => {
    let previous = null;
    for (let i = 0; i < messages.length; i += 1) {
      if (host[i] !== null) {
        previous = host[i];
        continue;
      }
      let value = entries.get(keys[i]);
      if (!Number.isFinite(value)) {
        value = previous === null ? now + i : Math.max(now + i, previous + 1);
        entries.set(keys[i], value);
      }
      out[i] = value;
      previous = value;
    }
  });
  return out;
}

export function fallbackKeys(conversationId, messages) {
  const keys = new Array(messages.length);
  let start = 0;
  const close = (end) => {
    if (end <= start) return;
    const digest = createHash("sha256").update(String(conversationId ?? ""));
    for (let i = start; i < end; i += 1) digest.update("\n").update(signature(messages[i]));
    const segment = digest.digest("hex").slice(0, 32);
    for (let i = start; i < end; i += 1) {
      const nativeId = messages[i]?.nativeId;
      keys[i] = typeof nativeId === "string" && nativeId ? `id:${nativeId}` : `${segment}:${i - start}`;
    }
  };
  for (let i = 0; i < messages.length; i += 1) {
    if (i > start && messages[i]?.role === "user") {
      close(i);
      start = i;
    }
  }
  close(messages.length);
  return keys;
}

function signature(message) {
  if (!message || typeof message !== "object") return "";
  try {
    return JSON.stringify([
      message.role ?? "",
      message.content ?? null,
      message.toolCallId ?? message.tool_call_id ?? "",
      message.toolCalls ?? null,
    ]);
  } catch {
    return String(message.role ?? "");
  }
}

/**
 * Process-local ledger. It keeps retries inside one process stable and is the
 * default for callers that pass no ledger, so library use never writes to
 * disk on its own.
 */
export function createMemoryTimestampLedger({
  maxConversations = MEMORY_MAX_CONVERSATIONS,
  maxEntries = LEDGER_MAX_ENTRIES,
} = {}) {
  const conversations = new Map();
  return {
    async withConversation(conversationId, fn) {
      const id = String(conversationId ?? "");
      const entries = conversations.get(id) ?? new Map();
      conversations.delete(id);
      fn(entries);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      conversations.set(id, entries);
      while (conversations.size > maxConversations) conversations.delete(conversations.keys().next().value);
    },
  };
}

/**
 * Ledger persisted under `<stateDir>/timestamps/`, one file per conversation,
 * so a detached worker or a later hook process resends with the values the
 * first send used. The entry is written before the request leaves.
 */
export function createTimestampLedger({
  stateDir = DEFAULT_STATE_DIR,
  maxAgeMs = LEDGER_MAX_AGE_MS,
  maxEntries = LEDGER_MAX_ENTRIES,
  lockWaitMs = LEDGER_LOCK_WAIT_MS,
  clock = Date.now,
} = {}) {
  const dir = path.join(stateDir || DEFAULT_STATE_DIR, LEDGER_DIR);
  let swept = false;
  return {
    async withConversation(conversationId, fn) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${fileKey(conversationId)}.json`);
      const lock = `${file}.lock`;
      if (!(await acquireLock(lock, lockWaitMs))) {
        throw new Error("everme_timestamp_ledger_lock_timeout");
      }
      try {
        const now = clock();
        const stored = await readLedger(file);
        const entries = new Map(stored.map(([key, value]) => [key, value]));
        const before = new Set(entries.keys());
        fn(entries);
        const assignedAt = new Map(stored.map(([key, , at]) => [key, at]));
        const rows = [];
        for (const [key, value] of entries) {
          const at = before.has(key) ? assignedAt.get(key) : now;
          if (Number.isFinite(at) && now - at > maxAgeMs) continue;
          rows.push([key, value, Number.isFinite(at) ? at : now]);
        }
        rows.sort((a, b) => a[2] - b[2]);
        await writeLedger(file, rows.slice(Math.max(0, rows.length - maxEntries)));
      } finally {
        await unlink(lock).catch(() => {});
      }
      if (!swept) {
        swept = true;
        await sweep(dir, maxAgeMs, clock());
      }
    },
  };
}

function fileKey(conversationId) {
  return createHash("sha256").update(String(conversationId ?? "")).digest("hex").slice(0, 40);
}

async function readLedger(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(parsed?.entries)
      ? parsed.entries.filter((row) => Array.isArray(row) && typeof row[0] === "string" && Number.isFinite(row[1]))
      : [];
  } catch {
    return [];
  }
}

async function writeLedger(file, rows) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ v: 1, entries: rows }), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temp, file);
    await chmod(file, 0o600);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

// Best effort, once per process: ledgers of conversations nobody has sent
// for a week are garbage.
async function sweep(dir, maxAgeMs, now) {
  try {
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      try {
        if (now - (await stat(file)).mtimeMs > maxAgeMs) await unlink(file);
      } catch {
        // Raced with another process; nothing to do.
      }
    }
  } catch {
    // A sweep failure must never fail a send.
  }
}
