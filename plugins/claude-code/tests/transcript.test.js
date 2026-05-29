import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { extractTurns, extractAgentMessages, buildTranscriptMarkdown } from "../hooks/scripts/lib/transcript.js";

describe("transcript.extractTurns", () => {
  test("flattens user + assistant + tool events with hasToolCall", () => {
    const lines = [
      JSON.stringify({ role: "user", content: "Find the latest bug", timestamp: 1 }),
      JSON.stringify({
        role: "assistant",
        content: [
          { type: "text", text: "I'll search the repo." },
          { type: "tool_use", name: "grep", input: { pattern: "TODO" } },
        ],
        timestamp: 2,
      }),
      JSON.stringify({
        role: "tool",
        content: "matched 3 lines",
        timestamp: 3,
      }),
      JSON.stringify({
        role: "assistant",
        content: [{ type: "text", text: "Here are the matches." }],
        timestamp: 4,
      }),
    ];
    const turns = extractTurns(lines);
    assert.equal(turns.length, 4);
    assert.equal(turns[0].role, "user");
    assert.equal(turns[1].role, "assistant");
    assert.equal(turns[1].hasToolCall, true);
    assert.equal(turns[2].role, "tool");
    assert.equal(turns[3].role, "assistant");
    assert.equal(turns[3].hasToolCall, false);
  });

  test("skips malformed JSONL lines silently", () => {
    const lines = [
      "this is not json",
      JSON.stringify({ role: "user", content: "hi", timestamp: 1 }),
      "}{",
    ];
    const turns = extractTurns(lines);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].text, "hi");
  });

  test("buildTranscriptMarkdown emits front matter + role headers", () => {
    const turns = [
      { role: "user", text: "hello", ts: 1714478400000, hasToolCall: false },
    ];
    const md = buildTranscriptMarkdown(turns, {
      sessionId: "sess_x",
      agentId: "agt_test",
    });
    assert.match(md, /everme_runtime_version: 1/);
    assert.match(md, /agent_id: agt_test/);
    assert.match(md, /session_key: sess_x/);
    assert.match(md, /## user · /);
    assert.match(md, /hello/);
  });

  test("extractAgentMessages preserves assistant tool calls and tool results", () => {
    const lines = [
      JSON.stringify({ role: "user", content: "Find the latest bug", timestamp: 1 }),
      JSON.stringify({
        role: "assistant",
        content: [
          { type: "text", text: "I'll search the repo." },
          { type: "tool_use", id: "toolu_1", name: "grep", input: { pattern: "TODO" } },
        ],
        timestamp: 2,
      }),
      JSON.stringify({
        role: "tool",
        tool_use_id: "toolu_1",
        content: "matched 3 lines",
        timestamp: 3,
      }),
    ];

    const messages = extractAgentMessages(lines);
    assert.equal(messages.length, 3);
    assert.equal(messages[1].role, "assistant");
    assert.equal(messages[1].toolCalls[0].id, "toolu_1");
    assert.equal(messages[1].toolCalls[0].arguments, '{"pattern":"TODO"}');
    assert.equal(messages[2].role, "tool");
    assert.equal(messages[2].toolCallId, "toolu_1");
  });
});
