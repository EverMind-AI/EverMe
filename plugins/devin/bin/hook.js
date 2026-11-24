#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactError, runHook } from "@everme/agent-sdk";
import { devinAdapter } from "../src/adapter.js";
import { promptKey, stashPrompt } from "../src/pending-prompt.js";
import { writeStopPayload } from "../src/stop-payload.js";

main().catch((error) => {
  const reason = redactError(error).replace(/\s+/g, " ").trim();
  process.stderr.write(`EverMe Devin hook degraded: ${reason}\n`);
  process.exitCode = 0;
});

async function main() {
  const [, , command, event] = process.argv;
  if (command !== "hook" || !event) return;
  adoptStateDir();
  const input = await readStdinJSON();
  // The prompt and the answer arrive as two events in two processes.
  // pre_user_prompt only parks the question so the response that follows
  // can be stored as a turn instead of an answer to nothing; it uploads
  // nothing itself.
  if (event === "pre_user_prompt") {
    await stashPrompt(input?.trajectory_id, input?.tool_info?.user_prompt, { timestamp: input?.timestamp });
    return;
  }
  // Devin Local: park the prompt by prompt_id for the Stop of the same
  // turn, then inject recall. The stash goes first so a slow recall cannot
  // cost the turn its question.
  if (event === "UserPromptSubmit") {
    await stashPrompt(promptKey(input?.session_id, input?.prompt_id), input?.prompt, {
      timestamp: new Date().toISOString(),
    }).catch(() => {});
  }
  // Devin Local waits for Stop hooks before it takes the next prompt, so the
  // upload runs in a detached worker and this process exits after one write.
  if (event === "Stop" && process.env.EVERME_DEVIN_SYNC_INLINE !== "1") {
    const payloadPath = await writeStopPayload({ ...input, timestamp: new Date().toISOString() });
    if (!payloadPath) return;
    const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.js");
    spawn(process.execPath, [worker, payloadPath], { detached: true, stdio: "ignore", env: process.env }).unref();
    return;
  }
  const output = await runHook(event, input, devinAdapter);
  if (output && Object.keys(output).length) {
    process.stdout.write(JSON.stringify(output));
  }
}

// The prompt stash and the Stop payload are written here but read back by
// the SDK runtime, which takes EVERME_STATE_DIR from everme.env. Both sides
// must agree on the directory, and the worker inherits this environment.
function adoptStateDir() {
  if (process.env.EVERME_STATE_DIR) return;
  let raw = "";
  try {
    raw = readFileSync(devinAdapter.envFile(), "utf8");
  } catch {
    return;
  }
  const match = raw.match(/^\s*EVERME_STATE_DIR\s*=\s*(.*?)\s*$/m);
  const value = match?.[1]?.replace(/^(['"])(.*)\1$/, "$2");
  if (value) process.env.EVERME_STATE_DIR = value;
}

async function readStdinJSON() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}
