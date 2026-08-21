import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  saveAgentMemory,
  flushAgentMemory,
  convertAgentMessage,
  EvermeError,
  MAX_MESSAGES_PER_REQUEST,
} from "../index.js";

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

  test("flushAgentMemory posts a flush-only request", async () => {
    const calls = [];
    const client = {
      async request(method, path, body) {
        calls.push({ method, path, body });
        return { status: "accumulated", messageCount: 0, flushed: true };
      },
    };

    const res = await flushAgentMemory(client, { conversationId: "sess-1" });

    assert.equal(res.flushed, true);
    assert.deepEqual(calls, [{
      method: "POST",
      path: "/mem/agent-memory",
      body: { conversationId: "sess-1", messages: [], flush: true },
    }]);
  });

  test("saveAgentMemory splits oversized uploads and flushes only on the last batch", async () => {
    const calls = [];
    const client = {
      async request(method, path, body) {
        calls.push({ method, path, body });
        return { status: "accumulated", messageCount: body.messages.length, flushed: body.flush };
      },
    };
    const messages = Array.from({ length: 1203 }, (_, i) => ({
      role: "user",
      timestamp: 1710000000000 + i,
      content: `message ${i}`,
    }));

    const res = await saveAgentMemory(client, { conversationId: "sess-big", messages, flush: true });

    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((call) => call.body.messages.length), [500, 500, 203]);
    assert.deepEqual(calls.map((call) => call.body.flush), [false, false, true]);
    // Leading batches must keep the synchronous-add guarantee (sync=true):
    // async leading batches can still be invisible to the final request's
    // flush — the first-flush data-loss shape, per request this time.
    assert.deepEqual(calls.map((call) => call.body.sync), [true, true, undefined]);
    assert.ok(calls.every((call) => call.path === "/mem/agent-memory" && call.body.conversationId === "sess-big"));
    assert.equal(calls[0].body.messages[0].content, "message 0");
    assert.equal(calls[2].body.messages[202].content, "message 1202");
    assert.equal(res.flushed, true);
    assert.equal(MAX_MESSAGES_PER_REQUEST, 500);
  });

  test("saveAgentMemory keeps flush=false on every batch when the caller did not flush", async () => {
    const calls = [];
    const client = {
      async request(method, path, body) {
        calls.push(body);
        return { flushed: body.flush };
      },
    };
    const messages = Array.from({ length: 501 }, (_, i) => ({
      role: "user",
      timestamp: 1710000000000 + i,
      content: `m${i}`,
    }));

    await saveAgentMemory(client, { conversationId: "sess-nf", messages, flush: false });

    assert.deepEqual(calls.map((body) => body.flush), [false, false]);
    assert.ok(calls.every((body) => body.sync === undefined),
      "append-only uploads must not force the sync path");
    assert.deepEqual(calls.map((body) => body.messages.length), [500, 1]);
  });

  test("saveAgentMemory surfaces a mid-batch failure instead of silent success", async () => {
    const calls = [];
    const client = {
      async request(method, path, body) {
        calls.push(body);
        if (calls.length === 2) {
          throw new EvermeError({ message: "server rejected batch", status: 500, code: 50301 });
        }
        return { flushed: body.flush };
      },
    };
    const messages = Array.from({ length: 1100 }, (_, i) => ({
      role: "user",
      timestamp: 1710000000000 + i,
      content: `m${i}`,
    }));

    await assert.rejects(
      saveAgentMemory(client, { conversationId: "sess-fail", messages, flush: true }),
      (error) => {
        // Assert the numeric code, not the message: upstream error copy is
        // known to be misleading (e.g. errno 50301's text).
        assert.equal(error.code, 50301);
        assert.equal(error.httpStatus, 500);
        return true;
      },
    );
    assert.equal(calls.length, 2, "stops at the failing batch; no further batches sent");
    assert.equal(calls[0].flush, false, "no flush was issued before the failure");
  });

  test("saveAgentMemory permits an explicit flush-only request", async () => {
    const calls = [];
    const client = {
      async request(method, path, body) {
        calls.push({ method, path, body });
        return { flushed: true };
      },
    };

    await saveAgentMemory(client, {
      conversationId: "sess-1",
      messages: [],
      flush: true,
    });

    assert.deepEqual(calls[0].body, {
      conversationId: "sess-1",
      messages: [],
      flush: true,
    });
  });
});
