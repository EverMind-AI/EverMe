import { mkdir, readFile, readdir, rename, stat, unlink, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_STATE_DIR = path.join(os.homedir(), ".everme", "state");

// Session state files are keyed by session id and become garbage once the
// host session is gone; prune anything untouched for this long on the next
// state write so ~/.everme/state does not grow without bound.
const STATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Per-session persisted state, one JSON file per session under stateDir:
 *
 *   { count, lastTurnId, uploadedCount }
 *
 * - count/lastTurnId back the per-turn dedup + flush cadence (turn counter);
 * - uploadedCount is the boundary-flush high-water mark: how many session
 *   messages have already been uploaded, so a re-fired SessionEnd or a
 *   resumed session only uploads the delta.
 */
export function createSessionState({ stateDir = DEFAULT_STATE_DIR } = {}) {
  const fileFor = (sessionId) => path.join(stateDir, `${sanitizeSessionId(sessionId)}.json`);
  return {
    read(sessionId) {
      return readState(fileFor(sessionId));
    },
    async patch(sessionId, patch) {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const file = fileFor(sessionId);
      const next = { ...(await readState(file)), ...patch };
      await writeState(file, next);
      await pruneStaleStateFiles(stateDir, file);
      return next;
    },
  };
}

/**
 * Two-phase turn counter. `peek` answers "is this turn a duplicate?" without
 * persisting anything; `commit` advances the counter and records the turn id.
 * Callers MUST commit only after the turn was durably handed to the gateway —
 * persisting before the enqueue would consume the turn id on a failed
 * enqueue, and the host's retry of the same turn would be deduped away.
 */
export function createTurnCounter({ stateDir = DEFAULT_STATE_DIR } = {}) {
  const store = createSessionState({ stateDir });
  return {
    async peek(sessionId, turnId) {
      const current = await store.read(sessionId);
      if (turnId && current.lastTurnId === turnId) {
        return { count: current.count, duplicate: true };
      }
      return { count: current.count + 1, duplicate: false };
    },
    async commit(sessionId, turnId) {
      const current = await store.read(sessionId);
      const next = await store.patch(sessionId, {
        count: current.count + 1,
        lastTurnId: turnId || "",
      });
      return { count: next.count, duplicate: false };
    },
  };
}

async function readState(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return {
      count: nonNegativeInteger(parsed.count),
      lastTurnId: typeof parsed.lastTurnId === "string" ? parsed.lastTurnId : "",
      uploadedCount: nonNegativeInteger(parsed.uploadedCount),
    };
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return { count: 0, lastTurnId: "", uploadedCount: 0 };
  }
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

async function writeState(file, state) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(state), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temp, file);
    await chmod(file, 0o600);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

// Best-effort: never let cleanup failures break the write path.
async function pruneStaleStateFiles(stateDir, keepFile) {
  try {
    const cutoff = Date.now() - STATE_MAX_AGE_MS;
    for (const name of await readdir(stateDir)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(stateDir, name);
      if (file === keepFile) continue;
      try {
        const info = await stat(file);
        if (info.mtimeMs < cutoff) await unlink(file);
      } catch {
        // Racing writers / already gone — ignore.
      }
    }
  } catch {
    // Unreadable state dir — ignore.
  }
}

function sanitizeSessionId(sessionId) {
  const sanitized = String(sessionId || "default")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return sanitized || "default";
}
