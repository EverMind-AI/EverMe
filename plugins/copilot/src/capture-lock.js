/**
 * Per-session lock for the detached capture worker (see bin/hook.js).
 */

import { readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The holder runs with the SDK's detached budget (DETACHED_HOOK_BUDGET_MS,
// 180 s); a waiter outlasts it so the two captures never run side by side.
// A literal, not the import: an install against an older SDK lacks the export.
const CAPTURE_LOCK_WAIT_MS = 210 * 1000;
const CAPTURE_LOCK_POLL_MS = 50;
// A lock file exists empty between its creation and the pid write. Only an
// empty lock older than this belongs to a worker that died in that window.
const HALF_WRITTEN_LOCK_MS = 5 * 1000;

// Past the wait ceiling the capture runs anyway: the SDK lock still keeps the
// upload correct, and only the loss report can be wrong.
export async function withCaptureLock(sessionId, run, { waitMs = CAPTURE_LOCK_WAIT_MS } = {}) {
  if (typeof sessionId !== "string" || !sessionId) return run();
  const lock = captureLockPath(sessionId);
  const deadline = Date.now() + waitMs;
  let held = false;
  while (!held) {
    try {
      await writeFile(lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      held = true;
    } catch (error) {
      if (error?.code !== "EEXIST") return run();
      if (!(await lockOwnerAlive(lock))) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() >= deadline) return run();
      await new Promise((resolve) => setTimeout(resolve, CAPTURE_LOCK_POLL_MS));
    }
  }
  try {
    return await run();
  } finally {
    await rm(lock, { force: true });
  }
}

export function captureLockPath(sessionId) {
  return path.join(os.tmpdir(), `everme-copilot-${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.lock`);
}

async function lockOwnerAlive(lock) {
  let pid;
  try {
    pid = Number.parseInt(await readFile(lock, "utf8"), 10);
  } catch {
    return true;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    try {
      return Date.now() - (await stat(lock)).mtimeMs < HALF_WRITTEN_LOCK_MS;
    } catch {
      return true;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
