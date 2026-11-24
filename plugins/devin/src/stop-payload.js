/**
 * Hand a Devin Local Stop event from the hook to its detached worker.
 *
 * The event carries the full assistant answer, which can exceed what argv
 * holds, so it goes through an owner-only file in the hook state directory
 * that the worker reads once and deletes.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function stateDirOf(options = {}) {
  return options.stateDir || process.env.EVERME_STATE_DIR || path.join(os.tmpdir(), "everme-devin");
}

export async function writeStopPayload(input, options = {}) {
  if (typeof input?.session_id !== "string" || !input.session_id.trim()) return "";
  const dir = stateDirOf(options);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `devin-stop-${randomUUID()}.json`);
  await writeFile(file, JSON.stringify(input), { encoding: "utf8", mode: 0o600 });
  return file;
}

export async function takeStopPayload(file, options = {}) {
  const dir = path.resolve(stateDirOf(options));
  const resolved = path.resolve(String(file || ""));
  // The path arrives on argv; read nothing outside the state directory.
  if (path.dirname(resolved) !== dir || !path.basename(resolved).startsWith("devin-stop-")) return null;
  let raw;
  try {
    raw = await readFile(resolved, "utf8");
  } catch {
    return null;
  }
  await rm(resolved, { force: true }).catch(() => {});
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
