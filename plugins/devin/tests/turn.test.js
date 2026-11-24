import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { messagesForEvent } from "../src/turn.js";

// Devin never emitted post_cascade_response_with_transcript in a real
// session - only post_cascade_response, which carries the answer inline
// and names no transcript file. So the turn is assembled from tool_info,
// not parsed out of a transcript. Shapes observed on a real machine:
//   pre_user_prompt        tool_info = { user_prompt }
//   post_run_command       tool_info = { command_line, cwd }
//   post_cascade_response  tool_info = { response }
describe("Devin turn assembly", () => {
  test("a response is paired with the prompt that triggered it", () => {
    const messages = messagesForEvent(
      "post_cascade_response",
      { toolInfo: { response: "42" } },
      { prompt: "how many lines" },
    );
    assert.deepEqual(messages, [
      { role: "user", content: "how many lines" },
      { role: "assistant", content: "42" },
    ]);
  });

  test("a response with no remembered prompt still stores the answer", () => {
    assert.deepEqual(
      messagesForEvent("post_cascade_response", { toolInfo: { response: "42" } }, ""),
      [{ role: "assistant", content: "42" }],
    );
  });

  test("an empty response preserves the real prompt", () => {
    assert.deepEqual(messagesForEvent("post_cascade_response", { toolInfo: { response: "  " } }, { prompt: "p" }), [{ role: "user", content: "p" }]);
    assert.deepEqual(messagesForEvent("post_cascade_response", { toolInfo: {} }, { prompt: "p" }), [{ role: "user", content: "p" }]);
  });

  test("a turn execution id is not fabricated into a command call id", () => {
    const messages = messagesForEvent("post_run_command", {
      turnId: "exec-1",
      toolInfo: { command_line: "wc -l /etc/paths", cwd: "/Users/admin" },
    });
    assert.deepEqual(messages, []);
  });

  test("a run_command with no command is not worth a tool call", () => {
    assert.deepEqual(messagesForEvent("post_run_command", { toolInfo: {} }), []);
  });

  // Devin reports the command it ran but not what came back, so the tool
  // call is deliberately emitted without a paired tool result. Inventing
  // an empty result would claim we captured output we never saw.
  test("no tool result is fabricated for a command whose output we never get", () => {
    const messages = messagesForEvent("post_run_command", {
      turnId: "e",
      toolInfo: { command_line: "ls" },
    });
    assert.equal(messages.filter((m) => m.role === "tool").length, 0);
  });

  // Observed on a real read: post_read_code carries only { file_path }.
  test("a read without native call identity is not fabricated into a call", () => {
    const messages = messagesForEvent("post_read_code", {
      turnId: "exec-2",
      toolInfo: { file_path: "/etc/paths" },
    });
    assert.deepEqual(messages, []);
  });

  test("a read with no path is not worth a tool call", () => {
    assert.deepEqual(messagesForEvent("post_read_code", { toolInfo: {} }), []);
  });

  test("an event we do not handle contributes nothing", () => {
    assert.deepEqual(messagesForEvent("post_write_code", { toolInfo: { path: "x" } }), []);
  });
});
