import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { filterInvalidTools } from "../src/tool-validation.js";

const call = (overrides = {}) => ({
  id: "call_1",
  type: "function",
  name: "Bash",
  arguments: "{}",
  ...overrides,
});

describe("filterInvalidTools", () => {
  test("returns the input untouched when every call is valid", () => {
    const messages = [
      { role: "assistant", timestamp: 1, toolCalls: [call()] },
      { role: "tool", timestamp: 2, toolCallId: "call_1", content: "ok" },
    ];

    assert.equal(filterInvalidTools(messages), messages);
  });

  test("drops a nameless call and the result that pairs to it", () => {
    const messages = [
      { role: "assistant", timestamp: 1, toolCalls: [call({ name: "  " })] },
      { role: "tool", timestamp: 2, toolCallId: "call_1", content: "ok" },
    ];

    assert.deepEqual(filterInvalidTools(messages), []);
  });

  test("drops a call whose arguments are not valid JSON", () => {
    const messages = [
      { role: "assistant", timestamp: 1, toolCalls: [call({ arguments: "{oops" })] },
    ];

    assert.deepEqual(filterInvalidTools(messages), []);
  });

  test("treats absent arguments as invalid rather than as an empty object", () => {
    // The server validates arguments as JSON, so "" is not a no-argument call.
    const messages = [{ role: "assistant", timestamp: 1, toolCalls: [call({ arguments: "" })] }];

    assert.deepEqual(filterInvalidTools(messages), []);
  });

  test("keeps a result whose id is ambiguous across two calls", () => {
    // Two calls share one id, so nothing identifies which one the result
    // belongs to. Keeping it beats attributing it to the wrong call.
    const messages = [
      { role: "assistant", timestamp: 1, toolCalls: [call({ name: "" })] },
      { role: "assistant", timestamp: 2, toolCalls: [call()] },
      { role: "tool", timestamp: 3, toolCallId: "call_1", content: "ok" },
    ];

    const kept = filterInvalidTools(messages);

    assert.equal(kept.filter((message) => message.role === "tool").length, 1);
  });

  test("keeps the assistant text when only its call was invalid", () => {
    const messages = [
      { role: "assistant", timestamp: 1, content: "let me look", toolCalls: [call({ name: "" })] },
    ];

    assert.deepEqual(filterInvalidTools(messages), [
      { role: "assistant", timestamp: 1, content: "let me look" },
    ]);
  });

  test("keeps the valid sibling of an invalid call on the same message", () => {
    const messages = [
      {
        role: "assistant",
        timestamp: 1,
        toolCalls: [call({ id: "bad", name: "" }), call({ id: "good" })],
      },
    ];

    assert.deepEqual(filterInvalidTools(messages), [
      { role: "assistant", timestamp: 1, toolCalls: [call({ id: "good" })] },
    ]);
  });
});
