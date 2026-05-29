import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { savePersonalMemory, convertPersonalMessage } from "../src/personal-memory.js";

describe("personal memory", () => {
  test("convertPersonalMessage strips channel envelope from user content", () => {
    const enveloped =
      'Sender (untrusted metadata):\n```json\n{"label":"openclaw-feishu"}\n```\n\n我最热爱的季节是夏天';
    const out = convertPersonalMessage(
      { role: "user", timestamp: 1710000000000, content: enveloped },
      1,
    );
    assert.equal(out.content, "我最热爱的季节是夏天");
    assert.equal(out.role, "user");
    assert.equal(out.timestamp, 1710000000000);
  });

  test("convertPersonalMessage drops tool roles (personal path is user/assistant only)", () => {
    assert.equal(convertPersonalMessage({ role: "tool", timestamp: 1, content: "x" }, 1), null);
    assert.equal(convertPersonalMessage({ role: "toolResult", timestamp: 1, content: "x" }, 1), null);
  });

  test("savePersonalMemory posts to /mem/personal", async () => {
    const calls = [];
    const client = {
      async request(method, path, body) {
        calls.push({ method, path, body });
        return { status: "accumulated", messageCount: body.messages.length, flushed: true };
      },
    };

    const res = await savePersonalMemory(client, {
      conversationId: "sess-1",
      flush: true,
      messages: [
        { role: "user", timestamp: 1710000000000, content: "我最热爱的季节是夏天" },
        { role: "assistant", timestamp: 1710000001000, content: "已记录" },
      ],
    });

    assert.equal(res.messageCount, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].path, "/mem/personal");
    assert.equal(calls[0].body.conversationId, "sess-1");
    assert.equal(calls[0].body.flush, true);
    // tool-call fields never leak onto the personal wire shape.
    assert.equal("toolCalls" in calls[0].body.messages[0], false);
  });

  test("savePersonalMemory returns null for empty input without calling the client", async () => {
    let called = false;
    const client = { async request() { called = true; return {}; } };
    assert.equal(await savePersonalMemory(client, { conversationId: "s", messages: [] }), null);
    assert.equal(await savePersonalMemory(client, { conversationId: "", messages: [{ role: "user", content: "x" }] }), null);
    assert.equal(called, false);
  });
});
