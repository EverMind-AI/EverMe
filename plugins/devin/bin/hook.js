#!/usr/bin/env node

import { redactError, runHook } from "@everme/agent-sdk";
import { devinAdapter } from "../src/adapter.js";
import { stashPrompt } from "../src/pending-prompt.js";

main().catch((error) => {
  const reason = redactError(error).replace(/\s+/g, " ").trim();
  process.stderr.write(`EverMe Devin hook degraded: ${reason}\n`);
  process.exitCode = 0;
});

async function main() {
  const [, , command, event] = process.argv;
  if (command !== "hook" || !event) return;
  const input = await readStdinJSON();
  // The prompt and the answer arrive as two events in two processes.
  // pre_user_prompt only parks the question so the response that follows
  // can be stored as a turn instead of an answer to nothing; it uploads
  // nothing itself.
  if (event === "pre_user_prompt") {
    await stashPrompt(input?.trajectory_id, input?.tool_info?.user_prompt);
    return;
  }
  const output = await runHook(event, input, devinAdapter);
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
