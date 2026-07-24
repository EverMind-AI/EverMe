import { describe, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { codexAdapter } from "../src/adapter.js";

describe("Codex hook adapter", () => {
  test("normalizes Codex snake-case hook input", async () => {
    assert.deepEqual(
      await codexAdapter.normalizeInput({
        session_id: "session-1",
        transcript_path: "/tmp/rollout.jsonl",
        cwd: "/repo",
        prompt: "hello",
        turn_id: "turn-1",
        source: "resume",
      }, "UserPromptSubmit"),
      {
        sessionId: "session-1",
        transcriptPath: "/tmp/rollout.jsonl",
        cwd: "/repo",
        prompt: "hello",
        turnId: "turn-1",
        source: "resume",
      },
    );
  });

  test("leaves the session id empty when absent so writes are skipped", async () => {
    const input = await codexAdapter.normalizeInput({ transcript_path: "/tmp/rollout.jsonl" }, "Stop");
    assert.equal(input.sessionId, "");
  });

  test("formats context events with the Codex hook envelope", () => {
    assert.deepEqual(
      codexAdapter.formatOutput("SessionStart", { block: "<everme_profile>facts</everme_profile>", count: 1 }),
      {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: "<everme_profile>facts</everme_profile>",
        },
      },
    );
    assert.deepEqual(
      codexAdapter.formatOutput("UserPromptSubmit", { block: "<everme_recall>memory</everme_recall>", count: 1 }),
      {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: "<everme_recall>memory</everme_recall>",
        },
      },
    );
  });

  test("emits no payload for write events or empty context", () => {
    assert.deepEqual(codexAdapter.formatOutput("Stop", { block: "", count: 2 }), {});
    assert.deepEqual(codexAdapter.formatOutput("PreCompact", { block: "", count: 0 }), {});
    assert.deepEqual(codexAdapter.formatOutput("SessionStart", { block: "", count: 0 }), {});
  });

  test("uses the Codex credential file by default", () => {
    const previous = process.env.EVERME_ENV_FILE_PATH;
    delete process.env.EVERME_ENV_FILE_PATH;
    try {
      assert.equal(codexAdapter.envFile(), path.join(os.homedir(), ".codex", "everme.env"));
    } finally {
      if (previous === undefined) delete process.env.EVERME_ENV_FILE_PATH;
      else process.env.EVERME_ENV_FILE_PATH = previous;
    }
  });
});
