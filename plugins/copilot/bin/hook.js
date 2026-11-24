#!/usr/bin/env node

/**
 * Copilot CLI hook entrypoint.
 *
 * Registered by `evercli plugin install copilot-cli` in
 * <config-dir>/hooks/everme.json (~/.copilot, or $COPILOT_HOME), one entry
 * per event, in exec form so no shell runs:
 *
 *   <stage>/bin/hook.js sessionStart <config-dir>         (injects the profile)
 *   <stage>/bin/hook.js userPromptSubmitted <config-dir>  (returns recall)
 *   <stage>/bin/hook.js agentStop <config-dir>            (captures the turn)
 *   <stage>/bin/hook.js sessionEnd <config-dir>           (captures what is left)
 *
 * Contract with the host: stdin carries the hook input as JSON; stdout is one
 * JSON object, of which sessionStart and userPromptSubmitted read
 * `additionalContext`. Exit 2 only warns, and every failure path here exits 0.
 *
 * Copilot CLI has no async hook option and waits for every hook. The two
 * capture events therefore hand the read + upload to a detached copy of this
 * script and return at once. In prompt mode agentStop and sessionEnd fire
 * about 50 ms apart, so the two detached captures of one session overlap. The
 * SDK's own lock keeps them from uploading the same delta, but it reads the
 * in-flight marker before it takes that lock, and the second capture then
 * reports the first one's turn as lost. The detached worker therefore holds a
 * per-session lock for the whole capture.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { redactError, runHook } from "@everme/agent-sdk";
import { copilotAdapter } from "../src/adapter.js";
import { withCaptureLock } from "../src/capture-lock.js";

const DETACHED_EVENTS = new Set(["agentStop", "sessionEnd"]);
const DETACHED_FLAG = "--detached";

main().catch((error) => {
  const reason = redactError(error).replace(/\s+/g, " ").trim();
  process.stderr.write(`EverMe Copilot CLI hook degraded: ${reason}\n`);
  process.exitCode = 0;
});

async function main() {
  const [, , event, configDir, flag, payload] = process.argv;
  if (!event) return;
  if (configDir && !process.env.EVERCLI_COPILOT_CONFIG_DIR) process.env.EVERCLI_COPILOT_CONFIG_DIR = configDir;

  if (flag === DETACHED_FLAG) {
    const input = parse(payload);
    await withCaptureLock(input.sessionId, () => runHook(event, input, copilotAdapter, { detached: true }));
    return;
  }
  const input = parse(await readStdin());
  if (DETACHED_EVENTS.has(event) && process.env.EVERME_COPILOT_INLINE !== "1") {
    spawn(process.execPath, [fileURLToPath(import.meta.url), event, configDir || "", DETACHED_FLAG, JSON.stringify(input)], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return;
  }
  const output = await runHook(event, input, copilotAdapter);
  if (output && Object.keys(output).length) process.stdout.write(JSON.stringify(output));
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function parse(text) {
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
