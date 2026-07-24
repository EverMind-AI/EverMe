import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { saveAgentMemory } from "@everme/agent-sdk";
import { readLastTurn } from "../src/transcript.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "codex-rollout.jsonl");
const emptyFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "empty-rollout.jsonl");

describe("Codex rollout parser", () => {
  test("streams only the latest user turn and preserves the tool trajectory", async () => {
    const messages = await readLastTurn(fixture);

    assert.deepEqual(messages, [
      {
        role: "user",
        timestamp: 1749001003000,
        content: "inspect config.json",
      },
      {
        role: "assistant",
        timestamp: 1749001005000,
        toolCalls: [{
          id: "call_latest",
          type: "function",
          name: "read_file",
          arguments: '{"path":"config.json"}',
        }],
      },
      {
        role: "tool",
        timestamp: 1749001006000,
        toolCallId: "call_latest",
        content: '{"enabled":true}',
      },
      {
        role: "assistant",
        timestamp: 1749001007000,
        content: "Memory is enabled.",
      },
      {
        // Real Codex rollouts write ISO-8601 timestamps — must parse to
        // epoch milliseconds, not fall through as unparseable.
        role: "assistant",
        timestamp: 1749001008000,
        content: "Config check complete.",
      },
      {
        // Missing timestamp must stay ABSENT (no 0 sentinel: 0 is a finite
        // 1970 epoch the SDK would ship as-is instead of stamping now()).
        role: "assistant",
        content: "Untimed trailing note.",
      },
    ]);
    assert.ok(!("timestamp" in messages[5]));
  });

  test("the SDK stamps messages that carry no timestamp", async () => {
    const bodies = [];
    const client = {
      async request(method, requestPath, body) {
        bodies.push(body);
        return { flushed: false };
      },
    };
    const floor = Date.now();

    await saveAgentMemory(client, {
      conversationId: "codex-session",
      messages: await readLastTurn(fixture),
      flush: false,
    });

    const wire = bodies[0].messages;
    assert.equal(wire[4].timestamp, 1749001008000, "ISO timestamp ships as parsed epoch-ms");
    assert.notEqual(wire[5].timestamp, 0, "missing timestamp must not ship as 0");
    assert.ok(Number.isFinite(wire[5].timestamp) && wire[5].timestamp >= floor,
      "missing timestamp is stamped by the SDK at send time");
  });

  test("over-long tool output keeps head AND tail after truncation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "everme-codex-transcript-"));
    try {
      const head = "HEAD_MARKER ";
      const tail = " exit status 1: TAIL_ROOT_CAUSE";
      const output = head + "x".repeat(20000) + tail;
      const rollout = path.join(dir, "rollout.jsonl");
      await writeFile(rollout, [
        JSON.stringify({ timestamp: 1749001000000, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] } }),
        JSON.stringify({ timestamp: 1749001001000, type: "response_item", payload: { type: "function_call", name: "shell", call_id: "call_1", arguments: "{}" } }),
        JSON.stringify({ timestamp: 1749001002000, type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output } }),
      ].join("\n"));

      const messages = await readLastTurn(rollout);
      const toolMsg = messages.find((m) => m.role === "tool");
      assert.ok(Array.from(toolMsg.content).length <= 8000, "content capped to the gateway rune limit");
      assert.match(toolMsg.content, /^HEAD_MARKER /, "head survives");
      assert.match(toolMsg.content, /TAIL_ROOT_CAUSE$/, "tail (exit status / root cause) survives");
      assert.match(toolMsg.content, /trimmed \d+ chars/, "middle marker present");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns an empty delta when no user message exists", async () => {
    assert.deepEqual(await readLastTurn(emptyFixture), []);
  });
});
