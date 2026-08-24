#!/usr/bin/env node

import { redactError, runHook } from "@everme/agent-sdk";
import { cursorAdapter } from "../src/adapter.js";

main().catch((error) => {
  const reason = redactError(error).replace(/\s+/g, " ").trim();
  process.stderr.write(`EverMe Cursor hook degraded: ${reason}\n`);
  process.exitCode = 0;
});

async function main() {
  const [, , command, event] = process.argv;
  if (command !== "hook" || !event) return;
  const input = await readStdinJSON();
  const output = await runHook(event, input, cursorAdapter);
  if (output && Object.keys(output).length) {
    process.stdout.write(JSON.stringify(output));
  }
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
