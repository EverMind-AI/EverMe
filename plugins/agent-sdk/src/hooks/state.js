import { mkdir, readFile, readdir, rename, stat, unlink, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_STATE_DIR = path.join(os.homedir(), ".everme", "state");

// Session state files are keyed by session id and become garbage once the
// host session is gone; prune anything untouched for this long on the next
// state write so ~/.everme/state does not grow without bound.
const STATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Per-session persisted state, one JSON file per session under stateDir:
 *
 *   { count, lastTurnId, uploadedCount, pendingTurn, lostTurns, stopStored }
 *
 * - count/lastTurnId back the per-turn dedup + flush cadence (turn counter);
 * - uploadedCount is the boundary-flush high-water mark: how many session
 *   messages have already been uploaded, so a re-fired SessionEnd or a
 *   resumed session only uploads the delta;
 * - pendingTurn is the delivery marker: written before the turn's transcript
 *   is even read and cleared on ACK. A hook the watchdog kills leaves nothing
 *   else behind, so this marker is the only evidence that turn existed. Stop
 *   hooks within one session are sequential, so a marker still present when
 *   the next one starts means the previous turn never landed — no staleness
 *   window is involved in that judgement;
 * - stopStored says whether a Stop (true) or a SessionEnd (false) stored the
 *   last turn, for hosts whose one-shot mode stores at SessionEnd. Absent in
 *   a file that predates it;
 * - lostTurns is how many of those losses telemetry has not accepted yet.
 *   Reporting can fail exactly when turns are being lost, so the debt is
 *   persisted here and drained on later turns instead of dying with the
 *   process that observed it.
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
    // `extra` rides along on the same write so clearing the delivery marker
    // on a committed turn costs no second file write.
    async commit(sessionId, turnId, extra = {}) {
      const current = await store.read(sessionId);
      const next = await store.patch(sessionId, {
        count: current.count + 1,
        lastTurnId: turnId || "",
        ...extra,
      });
      return { count: next.count, duplicate: false };
    },
  };
}

// A lock left behind by a process that died is worthless after this long. The
// host's async watchdog kills a detached hook well inside it, so anything
// older is certainly dead.
// Waiters QUEUE; they do not give up and skip. A second Stop for one session
// is not necessarily a duplicate of the delta being uploaded - it is just as
// likely the next turn the user already finished. A waiter that skipped left
// those rows uncommitted, and with no further Stop they were gone. Since the
// delta is derived from the checkpoint INSIDE the section, a waiter that runs
// later simply computes the remaining rows, so queueing is both correct and
// sufficient.
//
// Waiting is effectively unbounded, and that is safe rather than reckless: a
// holder either finishes or dies, and a dead one is reaped by liveness below.
// A detached capture process is itself killed by the host's asyncTimeout, so
// "forever" is bounded by the OS.
//
// The ceiling only exists so a non-hook caller cannot spin indefinitely. Hitting
// it THROWS. It must never fall back to running the section unlocked: the holder
// snapshotted earlier, so its commit would overwrite the waiter's - a lost
// update, silent and worse than the skip this replaced. Throwing leaves the rows
// uncommitted, which the next Stop picks up, and says so on stderr.
const LOCK_WAIT_MS = 10 * 60 * 1000;
const LOCK_POLL_MS = 25;
// Backstop for pid reuse only: liveness is what actually decides staleness.
const LOCK_ABANDONED_MS = 10 * 60 * 1000;

export async function acquireLock(lock, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      // 'wx' fails when the file exists, so creation IS the acquisition.
      await writeFile(lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await reapStaleLock(lock)) continue;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
}

/**
 * Removes a lock whose owner is gone. Returns true when the caller should
 * retry immediately.
 *
 * Staleness is the owner's LIVENESS, not the lock's age. An age rule cannot
 * tell a dead holder from a slow one: a short threshold steals the lock from a
 * process still uploading, and a long one makes every waiter behind a crashed
 * hook sit out the full budget. The pid in the file answers it exactly.
 */
async function reapStaleLock(lock) {
  let owner;
  try {
    owner = Number.parseInt(await readFile(lock, "utf8"), 10);
  } catch {
    // Vanished while we looked - the holder released it, so retry.
    return true;
  }
  if (Number.isInteger(owner) && owner > 0 && ownerAlive(owner)) {
    // Alive: leave it alone however long it takes, unless the file is old
    // enough that this pid is more plausibly a reused number than our holder.
    try {
      const info = await stat(lock);
      if (Date.now() - info.mtimeMs < LOCK_ABANDONED_MS) return false;
    } catch {
      return true;
    }
  }
  try {
    await unlink(lock);
  } catch {
    // Another waiter reaped it first; either way it is gone.
  }
  return true;
}

function ownerAlive(pid) {
  try {
    // Signal 0 checks existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else.
    return error?.code === "EPERM";
  }
}

export function createTranscriptCheckpointStore({
  stateDir = DEFAULT_STATE_DIR,
  // Overridable so tests can drive the expiry path deterministically instead of
  // sitting out the production budget.
  lockWaitMs = LOCK_WAIT_MS,
} = {}) {
  const fileFor = (stateId) => path.join(stateDir, `${sanitizeSessionId(stateId)}.transcript.json`);
  const lockFor = (stateId) => `${fileFor(stateId)}.lock`;
  return {
    /**
     * Run `fn` as the only holder of this session's checkpoint.
     *
     * read -> upload -> commit is a read-modify-write across an await, and once
     * hooks are DETACHED (the host's async protocol) two Stop processes for one
     * session genuinely overlap. Both would read the same pre-state, upload the
     * same delta and commit it, and the gateway's client-native-id dedup is a
     * client declaration - it does not deduplicate server side. So the section
     * has to be mutually exclusive across PROCESSES, not just within one.
     *
     * Waiters QUEUE rather than skip. A second Stop for one session is not
     * necessarily the same delta - it is just as likely the next turn the user
     * already finished, and skipping left those rows uncommitted. Because the
     * delta is derived from the checkpoint INSIDE this section, a waiter that
     * runs later simply computes the rows that are still missing, so ordering
     * them is all it takes to be correct.
     *
     * `fn` runs ONLY under the lock. It is never run unlocked as a fallback:
     * the holder read an earlier snapshot, so its commit would overwrite the
     * waiter's.
     *
     * The lock is an O_EXCL file, atomic on every filesystem this runs on.
     */
    async withSession(stateId, fn) {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const lock = lockFor(stateId);
      if (!(await acquireLock(lock, lockWaitMs))) {
        throw new Error(`everme_checkpoint_lock_timeout:${sanitizeSessionId(stateId)}`);
      }
      try {
        await fn();
        return true;
      } finally {
        // Released even when fn throws: a leaked lock would wedge every later
        // turn of this session until its owner was seen to be gone.
        await unlink(lock).catch(() => {});
      }
    },
    async read(stateId) {
      try {
        const parsed = JSON.parse(await readFile(fileFor(stateId), "utf8"));
        return {
          initialized: parsed.initialized === true,
          uploadedCount: nonNegativeInteger(parsed.uploadedCount),
          ...(Array.isArray(parsed.nativeMessageIds) ? { nativeMessageIds: parsed.nativeMessageIds } : {}),
        };
      } catch (error) {
        if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        return { initialized: false, uploadedCount: 0 };
      }
    },
    async commit(stateId, uploadedCount, identity = {}) {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const file = fileFor(stateId);
      const next = { initialized: true, uploadedCount: nonNegativeInteger(uploadedCount) };
      if (Array.isArray(identity.nativeMessageIds)) next.nativeMessageIds = identity.nativeMessageIds;
      await writeState(file, next);
      await pruneStaleStateFiles(stateDir, file);
      return next;
    },
  };
}

// Rebuilds a fixed shape rather than spreading the parsed object: unknown
// keys from a newer or corrupted file never reach the rest of the hook. The
// trade-off is that a NEW field must be added here too, or it is written and
// then silently dropped on the next read.
async function readState(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return {
      count: nonNegativeInteger(parsed.count),
      lastTurnId: typeof parsed.lastTurnId === "string" ? parsed.lastTurnId : "",
      uploadedCount: nonNegativeInteger(parsed.uploadedCount),
      pendingTurn: pendingTurn(parsed.pendingTurn),
      lostTurns: nonNegativeInteger(parsed.lostTurns),
      ...(typeof parsed.stopStored === "boolean" ? { stopStored: parsed.stopStored } : {}),
    };
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return { count: 0, lastTurnId: "", uploadedCount: 0, pendingTurn: null, lostTurns: 0 };
  }
}

function pendingTurn(value) {
  if (!value || typeof value !== "object") return null;
  const startedAt = nonNegativeInteger(value.startedAt);
  if (!startedAt) return null;
  return { startedAt, turnId: typeof value.turnId === "string" ? value.turnId : "" };
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export async function writeState(file, state) {
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
export async function pruneStaleStateFiles(stateDir, keepFile) {
  try {
    const cutoff = Date.now() - STATE_MAX_AGE_MS;
    for (const name of await readdir(stateDir)) {
      // .json = session counters, cached skill bodies (.skill.json) and
      // transcript checkpoints; .toolbuf.jsonl = tool event buffers whose
      // turn never reached a Stop drain (aborted sessions).
      if (!name.endsWith(".json") && !name.endsWith(".toolbuf.jsonl")) continue;
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

export function sanitizeSessionId(sessionId) {
  const sanitized = String(sessionId || "default")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return sanitized || "default";
}
