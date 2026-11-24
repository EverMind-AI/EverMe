import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { entryKey, lastTurnStart, mapSession } from "../src/transcript.js";
import { partId } from "../src/ids.js";

const user = (id, text, extra = []) => ({
  info: { id, role: "user", time: { created: 1000 } },
  parts: [{ id: `${id}-p`, type: "text", text }, ...extra],
});

describe("opencode transcript", () => {
  it("maps text, tool calls and results in source order, skipping reasoning and steps", () => {
    const { entries, ready } = mapSession([
      user("msg_u1", "list the files", [
        { id: "prt_r", type: "text", synthetic: true, text: "<everme_recall>x</everme_recall>" },
      ]),
      {
        info: { id: "msg_a1", role: "assistant", parentID: "msg_u1", time: { created: 1100, completed: 1300 }, finish: "stop" },
        parts: [
          { id: "prt_s", type: "step-start" },
          { id: "prt_think", type: "reasoning", text: "thinking" },
          { id: "prt_t1", type: "text", text: "Let me look." },
          {
            id: "prt_tool",
            type: "tool",
            callID: "call_1",
            tool: "bash",
            state: { status: "completed", input: { command: "ls" }, output: "a.txt\nb.txt", time: { start: 1150, end: 1160 } },
          },
          { id: "prt_t2", type: "text", text: "Two files." },
          { id: "prt_f", type: "step-finish", reason: "stop" },
        ],
      },
    ]);
    assert.equal(ready, true);
    assert.deepEqual(entries.map((e) => e.role), ["user", "assistant", "assistant", "tool", "assistant"]);
    assert.equal(entries[0].content, "list the files");
    assert.equal(entries[1].content, "Let me look.");
    assert.equal(entries[1].turnComplete, false);
    assert.deepEqual(entries[2].toolCalls, [{ id: "call_1", type: "function", name: "bash", arguments: "{\"command\":\"ls\"}" }]);
    assert.equal(entries[3].toolCallId, "call_1");
    assert.equal(entries[3].content, "a.txt\nb.txt");
    assert.equal(entries[4].content, "Two files.");
    assert.equal(entries[4].turnComplete, true);
    for (const entry of entries) assert.doesNotMatch(JSON.stringify(entry), /everme_recall|thinking/);
    assert.equal(new Set(entries.map(entryKey)).size, entries.length);
  });

  it("keeps a tool error as the result text", () => {
    const { entries } = mapSession([
      user("msg_u1", "run it"),
      {
        info: { id: "msg_a1", role: "assistant", time: { created: 1, completed: 2 }, finish: "stop" },
        parts: [{ id: "prt_x", type: "tool", callID: "c", tool: "bash", state: { status: "error", input: {}, error: "boom" } }],
      },
    ]);
    assert.equal(entries.at(-1).role, "tool");
    assert.equal(entries.at(-1).content, "boom");
  });

  it("is not ready while the assistant or a tool is still running", () => {
    assert.equal(mapSession([user("u", "hi"), { info: { id: "a", role: "assistant", time: { created: 1 } }, parts: [] }]).ready, false);
    const running = mapSession([
      user("u", "hi"),
      {
        info: { id: "a", role: "assistant", time: { created: 1, completed: 2 }, finish: "tool-calls" },
        parts: [{ id: "p", type: "tool", callID: "c", tool: "bash", state: { status: "running", input: {} } }],
      },
    ]);
    assert.equal(running.ready, false);
  });

  it("does not mark a tool-calls finish as the final reply", () => {
    const { entries } = mapSession([
      user("u", "hi"),
      { info: { id: "a", role: "assistant", time: { created: 1, completed: 2 }, finish: "tool-calls" }, parts: [{ id: "t", type: "text", text: "working" }] },
    ]);
    assert.equal(entries.at(-1).turnComplete, false);
  });

  it("finds the newest user turn", () => {
    const { entries } = mapSession([user("u1", "a"), user("u2", "b")]);
    assert.equal(lastTurnStart(entries), 1);
  });

  it("makes part ids in the host's format that sort by time", () => {
    const first = partId(1_800_000_000_000);
    const second = partId(1_800_000_000_001);
    assert.match(first, /^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    assert.ok(first < second);
  });
});
