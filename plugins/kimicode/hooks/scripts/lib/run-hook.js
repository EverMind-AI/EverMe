import { runHook } from "@everme/agent-sdk";
import { kimiCodeAdapter } from "./adapter.js";
import { readStdinJSON } from "./kimi-stdin.js";

export async function runKimiCodeHook(event) {
  const output = await runHook(event, await readStdinJSON(), kimiCodeAdapter);
  if (output && Object.keys(output).length) process.stdout.write(`${JSON.stringify(output)}\n`);
}
