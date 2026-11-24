import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { devinAdapter } from "../src/adapter.js";
import { stashPrompt } from "../src/pending-prompt.js";
import { readLastTurn } from "../src/transcript.js";

const promptTime = "2026-09-06T08:00:00.000Z";
const eventTime = "2026-09-06T08:00:02.000Z";

test("empty answers preserve the pending prompt and its native timestamp", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-devin-events-"));
  try {
    await stashPrompt("session-1", "Read the file", { stateDir, timestamp: promptTime });
    const input = devinAdapter.normalizeInput({ trajectory_id: "session-1", execution_id: "turn-1", timestamp: eventTime, tool_info: { response: "" } }, "post_cascade_response");
    const messages = await devinAdapter.readLastTurn(input, { stateDir });
    assert.deepEqual(messages, [{ role: "user", content: "Read the file", timestamp: Date.parse(promptTime) }]);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("unidentifiable tool events leave the prompt for the real response", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-devin-events-"));
  try {
    await stashPrompt("session-1", "Run pwd", { stateDir, timestamp: promptTime });
    const action = devinAdapter.normalizeInput({ trajectory_id: "session-1", execution_id: "turn-1", timestamp: eventTime, tool_info: { command_line: "pwd" } }, "post_run_command");
    const messages = await devinAdapter.readLastTurn(action, { stateDir });
    assert.deepEqual(messages, []);
    const response = devinAdapter.normalizeInput({ trajectory_id: "session-1", execution_id: "turn-1", timestamp: "2026-09-06T08:00:03.000Z", tool_info: { response: "Done" } }, "post_cascade_response");
    assert.deepEqual(await devinAdapter.readLastTurn(response, { stateDir }), [
      { role: "user", content: "Run pwd", timestamp: Date.parse(promptTime) },
      { role: "assistant", content: "Done", timestamp: Date.parse(response.timestamp) },
    ]);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("transcript keeps real planner responses without a preceding user", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "everme-devin-events-"));
  try {
    const file = path.join(dir, "trace.jsonl");
    await writeFile(file, JSON.stringify({ status: "done", type: "planner_response", planner_response: { response: "A real answer" } }) + "\n");
    assert.deepEqual(await readLastTurn(file), [{ role: "assistant", content: "A real answer" }]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("invalid native conversation ids cannot be coerced into sessions", () => {
  for (const trajectory_id of [undefined, " ", 42, {}]) {
    assert.equal(devinAdapter.normalizeInput({ trajectory_id }, "post_cascade_response").sessionId, "");
  }
});
