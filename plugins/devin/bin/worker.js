#!/usr/bin/env node

/**
 * Detached Devin Local capture worker, spawned by bin/hook.js on Stop.
 */

import { fileURLToPath } from "node:url";
import { redactError, runHook } from "@everme/agent-sdk";
import { devinAdapter } from "../src/adapter.js";
import { takeStopPayload } from "../src/stop-payload.js";

export async function runWorker(payloadPath, deps = {}) {
  const input = await takeStopPayload(payloadPath, deps);
  if (!input) return;
  await (deps.runHook || runHook)("Stop", input, devinAdapter, { detached: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runWorker(process.argv[2]).catch((error) => {
    const reason = redactError(error).replace(/\s+/g, " ").trim();
    process.stderr.write(`EverMe Devin worker degraded: ${reason}\n`);
    process.exitCode = 0;
  });
}
