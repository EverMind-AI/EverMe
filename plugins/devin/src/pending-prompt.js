/**
 * Carry a user prompt from one Devin hook event to the next.
 *
 * Devin delivers the prompt (pre_user_prompt) and the answer
 * (post_cascade_response) as two events, each in its own short-lived
 * process. Without a handoff every stored turn would be an answer with no
 * question, so the prompt is parked on disk keyed by trajectory and
 * consumed by the response that follows it.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function stateDirOf(options = {}) {
  return options.stateDir || process.env.EVERME_STATE_DIR || path.join(os.tmpdir(), "everme-devin");
}

// The trajectory id comes from the host, so it is not allowed to steer
// the write anywhere but this directory.
function entryPath(trajectoryId, options) {
  const safe = String(trajectoryId).replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(stateDirOf(options), `devin-prompt-${safe}.json`);
}

// Devin Local pairs a prompt with its answer by prompt_id; the session id
// keeps two sessions that reuse a prompt id apart.
export function promptKey(sessionId, promptId) {
  if (typeof sessionId !== "string" || !sessionId.trim()) return "";
  if (typeof promptId !== "string" || !promptId.trim()) return "";
  return `${sessionId}.${promptId}`;
}

export async function stashPrompt(trajectoryId, prompt, options = {}) {
  const text = typeof prompt === "string" ? prompt.trim() : "";
  if (typeof trajectoryId !== "string" || !trajectoryId.trim() || !text) return;
  const dir = stateDirOf(options);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // The prompt is user content: keep it owner-only.
  await writeFile(entryPath(trajectoryId, options), JSON.stringify({ prompt: text, timestamp: options.timestamp }), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function takePrompt(trajectoryId, options = {}) {
  if (typeof trajectoryId !== "string" || !trajectoryId.trim()) return null;
  const file = entryPath(trajectoryId, options);
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  // Consume it either way: a prompt that cannot be parsed must not stay
  // behind to mislabel the next answer.
  await rm(file, { force: true }).catch(() => {});
  try {
    const entry = JSON.parse(raw);
    return typeof entry?.prompt === "string" ? entry : null;
  } catch {
    return null;
  }
}
