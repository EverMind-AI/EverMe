import { runHook } from "@everme/agent-sdk";
import { claudeCodeAdapter } from "./adapter.js";

export async function runClaudeCodeHook(event) {
  const output = await runHook(event, await readStdinJSON(), claudeCodeAdapter);
  if (output && Object.keys(output).length) process.stdout.write(JSON.stringify(output));
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
