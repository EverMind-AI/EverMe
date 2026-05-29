import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { saveAgentMemory, convertAgentMessage } from "../src/agent-memory.js";

describe("agent memory", () => {
  test("convertAgentMessage strips channel envelope from user content", () => {
    const enveloped =
      'Sender (untrusted metadata):\n```json\n{"label":"openclaw-feishu"}\n```\n\nremember my postgres index decision';
    const out = convertAgentMessage(
      { role: "user", timestamp: 1710000000000, content: enveloped },
      1,
    );
    assert.equal(out.content, "remember my postgres index decision");
  });

  test("convertAgentMessage strips channel envelope from assistant text", () => {
    const out = convertAgentMessage(
      {
        role: "assistant",
        timestamp: 1710000001000,
        content: [
          { type: "text", text: "Sender (untrusted metadata):\n```json\n{}\n```\nok, noted." },
        ],
      },
      2,
    );
    assert.equal(out.content, "ok, noted.");
  });

  test("convertAgentMessage preserves tool trajectory", () => {
    const out = [
      convertAgentMessage({ role: "user", timestamp: 1710000000000, content: [{ type: "text", text: "weather?" }] }, 1),
      convertAgentMessage({
        role: "assistant",
        timestamp: 1710000001000,
        content: [
          { type: "text", text: "Let me check" },
          { type: "toolCall", id: "call_a", name: "get_weather", arguments: { city: "Tokyo" } },
        ],
      }, 2),
      convertAgentMessage({ role: "toolResult", timestamp: 1710000002000, toolCallId: "call_a", content: [{ type: "text", text: "18C" }] }, 3),
    ];

    assert.equal(out[0].role, "user");
    assert.equal(out[0].content, "weather?");
    assert.equal(out[1].role, "assistant");
    assert.equal(out[1].toolCalls[0].id, "call_a");
    assert.equal(out[1].toolCalls[0].arguments, '{"city":"Tokyo"}');
    assert.equal(out[2].role, "tool");
    assert.equal(out[2].toolCallId, "call_a");
  });

  test("saveAgentMemory posts to /mem/agent-memory", async () => {
    const calls = [];
    const client = {
      async request(method, path, body) {
        calls.push({ method, path, body });
        return { status: "accumulated", messageCount: body.messages.length, flushed: true };
      },
    };

    const res = await saveAgentMemory(client, {
      conversationId: "sess-1",
      flush: true,
      messages: [
        { role: "user", timestamp: 1710000000000, content: "hi" },
        { role: "assistant", timestamp: 1710000001000, content: "hello" },
      ],
    });

    assert.equal(res.messageCount, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].path, "/mem/agent-memory");
    assert.equal(calls[0].body.conversationId, "sess-1");
    assert.equal(calls[0].body.flush, true);
  });
});
