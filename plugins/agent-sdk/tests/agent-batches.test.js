import test from "node:test";
import assert from "node:assert/strict";
import { batchAgentMessages } from "../src/agent-batches.js";
import { batchUserTasks } from "../src/task-batches.js";

test("task batching keeps fitting results and adapts oversized tasks from original UTF-8", () => {
  for (const [calls, budget] of [[10, null], [30, 4096], [70, 3072], [100, 2048], [150, 2048]]) {
    const original = "Script completed\n" + "\u4e2d\u6587\ud83d\ude42".repeat(1000) + "\nexit code: 0";
    const messages = [user()];
    for (let i = 0; i < calls; i++) messages.push(call(String(i)), { ...result(String(i)), content: original });
    messages.push(assistant());
    const firstEnd = messages.length;
    messages.push(user(), call("next"), { ...result("next"), content: original }, assistant());
    const before = structuredClone(messages);
    const metadata = messages.map((message) => ({ turnComplete: message.role === "assistant" && !message.toolCalls }));
    const batches = batchUserTasks(messages, metadata);
    if (calls >= 30 && calls < 150) assert.equal(batches[0].length, firstEnd);
    if (calls === 150) assert.ok(batches.length >= 3);
    for (const batch of batches) {
      assert.ok(batch.length <= 500);
      assert.ok(batch.reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message)), 0) <= 280 * 1024);
    }
    const flat = batches.flat();
    assert.equal(flat.length, messages.length);
    assert.equal(flat[firstEnd + 2].content, original);
    for (let i = 0; i < firstEnd; i++) {
      if (flat[i].role !== "tool") continue;
      if (budget) {
        assert.ok(Buffer.byteLength(flat[i].content) <= budget);
        assert.doesNotMatch(flat[i].content, /\ufffd/);
        assert.match(flat[i].content, /^Script completed/);
        assert.match(flat[i].content, /exit code: 0$/);
        assert.equal((flat[i].content.match(/trimmed/g) || []).length, 1);
      } else assert.equal(flat[i].content, original);
      flat[i] = { ...flat[i], content: original };
    }
    assert.deepEqual(flat, before);
    assert.deepEqual(messages, before);
  }
});

test("count-only task overflow preserves complete pairs without compressing", () => {
  const messages = [user()];
  for (let i = 0; i < 251; i++) messages.push(call(String(i)), result(String(i)));
  messages.push(assistant());
  const batches = batchUserTasks(messages);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches.flat(), messages);
  for (const batch of batches) {
    const calls = batch.flatMap((message) => message.toolCalls || []).map((call) => call.id);
    assert.deepEqual(batch.filter((message) => message.role === "tool").map((message) => message.toolCallId), calls);
  }
});

const user = () => ({ role: "user", content: "question" });
const assistant = () => ({ role: "assistant", content: "answer" });
const call = (id) => ({ role: "assistant", toolCalls: [{ id, name: "shell", arguments: "{}" }] });
const result = (id) => ({ role: "tool", toolCallId: id, content: "" });

test("prefers a complete turn over a later complete tool pair", () => {
  const messages = [user(), assistant(), user(), call("c"), result("c"), assistant()];
  const batches = batchAgentMessages(messages, 5);
  assert.deepEqual(batches.map((batch) => batch.length), [2, 4]);
  assert.deepEqual(batches.flat(), messages);
});

test("uses a complete pair when the entire turn exceeds the limit", () => {
  const messages = [user(), call("a"), result("a"), call("b"), result("b"), assistant()];
  assert.deepEqual(batchAgentMessages(messages, 4).map((batch) => batch.length), [3, 3]);
});

test("uses the hard limit without dropping unpaired calls or inventing closure", () => {
  const messages = [user(), call("missing"), assistant(), user(), assistant(), assistant()];
  const batches = batchAgentMessages(messages, 4);
  assert.deepEqual(batches.map((batch) => batch.length), [4, 2]);
  assert.deepEqual(batches.flat(), messages);
});

test("does not split a fitting open trajectory at its last tool pair", () => {
  const messages = [user(), call("a"), result("a"), assistant()];
  assert.deepEqual(batchAgentMessages(messages, 500), [messages]);
});

test("waits for all parallel tool results before accepting a pair boundary", () => {
  const messages = [user(), { role: "assistant", toolCalls: [{ id: "a" }, { id: "b" }] }, result("a"), result("b"), assistant()];
  assert.deepEqual(batchAgentMessages(messages, 3).map((batch) => batch.length), [3, 2]);
  assert.deepEqual(batchAgentMessages(messages, 4).map((batch) => batch.length), [4, 1]);
});

test("uses explicit completion metadata without treating commentary as closure", () => {
  const messages = [assistant(), assistant(), assistant(), user(), assistant()];
  const metadata = [{}, { turnComplete: true }, { turnComplete: false }, {}, {}];
  assert.deepEqual(batchAgentMessages(messages, 4, metadata).map((batch) => batch.length), [2, 3]);
});

test("recognizes assistant-only turns by source turn ids", () => {
  const messages = Array.from({ length: 5 }, assistant);
  const metadata = [{ turnId: "a" }, { turnId: "a" }, { turnId: "b" }, { turnId: "b" }, { turnId: "b" }];
  assert.deepEqual(batchAgentMessages(messages, 4, metadata).map((batch) => batch.length), [2, 3]);
});

test("does not count a repeated result fragment as a full pair until the final fragment", () => {
  const messages = [user(), call("a"), result("a"), result("a"), assistant()];
  assert.deepEqual(batchAgentMessages(messages, 3).map((batch) => batch.length), [3, 2]);
});
