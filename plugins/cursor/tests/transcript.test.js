import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLastTurn } from "../src/transcript.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "cursor-transcript.jsonl");

describe("Cursor transcript parser", () => {
  test("returns only the latest user turn and ignores malformed or unknown steps", async () => {
    assert.deepEqual(await readLastTurn(fixture), [
      { role: "user", content: "latest question" },
      { role: "assistant", content: "latest answer" },
    ]);
  });

  test("returns an empty delta for unsupported transcript shapes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "everme-cursor-transcript-"));
    const file = path.join(dir, "unsupported.jsonl");
    try {
      await writeFile(file, [
        "not-json",
        JSON.stringify({ type: "reasoning", role: "assistant", text: "hidden reasoning" }),
        JSON.stringify({ type: "system", message: { role: "user", content: "injected system prompt" } }),
        "",
      ].join("\n"), "utf8");
      assert.deepEqual(await readLastTurn(file), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// The shape Cursor actually writes to the transcript it hands the Stop
// hook: role at the TOP level, message carrying only { content }. The
// hand-authored fixture above assumes a nested message.role that Cursor
// does not emit, so the parser passed its tests while extracting nothing
// from real sessions - 38 transcripts on a developer machine yielded 0
// messages. This is the 2026-08-17 review item 1.1.10, except the loss
// is the whole turn, not only the tool calls.
describe("Cursor transcript parser, host shape", () => {
  const hostShape = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "cursor-transcript-host-shape.jsonl",
  );

  test("reads a role declared at the top level of the record", async () => {
    assert.deepEqual(await readLastTurn(hostShape), [
      { role: "user", content: "latest question" },
      { role: "assistant", content: "latest answer" },
    ]);
  });
});

// These legacy compatibility fixtures are not evidence of a native writer schema.
describe("Cursor transcript parser, tool events", () => {
  const toolEvents = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "cursor-transcript-tool-events.jsonl",
  );

  test("keeps tool calls from content blocks and standalone records, paired with results", async () => {
    const warned = [];
    assert.deepEqual(await readLastTurn(toolEvents, { warn: (type) => warned.push(type) }), [
      { role: "user", content: "run the tests" },
      {
        role: "assistant",
        content: "running now",
        toolCalls: [{ id: "call_inline", type: "function", name: "shell", arguments: "{\"command\":\"npm test\"}" }],
      },
      {
        role: "assistant",
        toolCalls: [{ id: "call_standalone", type: "function", name: "read_file", arguments: "{\"path\":\"a.js\"}" }],
      },
      { role: "tool", toolCallId: "call_standalone", content: "file body" },
      { role: "assistant", content: "all green" },
    ]);
    assert.deepEqual(warned, ["invalid_tool_id", "unknown_record_type"]);
  });

  test("rejects a legacy tool record without a native ID", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "everme-cursor-transcript-"));
    const file = path.join(dir, "no-id.jsonl");
    try {
      await writeFile(file, [
        JSON.stringify({ type: "user", message: { content: "question" } }),
        JSON.stringify({ type: "tool_call", tool_name: "shell", tool_input: { command: "ls" } }),
        "",
      ].join("\n"), "utf8");
      const warnings = [];
      assert.deepEqual(await readLastTurn(file, { warn: (...args) => warnings.push(args) }), [
        { role: "user", content: "question" },
      ]);
      assert.deepEqual(warnings, [["invalid_tool_id", 1]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("Cursor 3.5.38 user envelope and ID-less inline calls are projected without inventions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "everme-cursor-native-"));
  const file = path.join(dir, "native.jsonl");
  try {
    await writeFile(file, [
      { role: "user", message: { content: [{ type: "text", text: "<timestamp>Thursday, May 28, 2026, 11:10 AM (UTC+1)</timestamp>\n<user_query>\nfollow the steps in the rs-readme-test readme file\n</user_query>" }] } },
      { role: "assistant", message: { content: [{ type: "text", text: "I’ll open the README." }, { type: "tool_use", name: "ReadFile", input: { path: "README.md" } }] } },
      { role: "assistant", message: { content: [{ type: "tool_use", name: "Shell", input: { command: "pwd" } }] } },
      { role: "assistant", message: { content: [{ type: "text", text: "Completed the README steps." }] } },
    ].map(JSON.stringify).join("\n"));
    const warnings = [];
    assert.deepEqual(await readLastTurn(file, { warn: (...args) => warnings.push(args) }), [
      { role: "user", content: "follow the steps in the rs-readme-test readme file" },
      { role: "assistant", content: "I’ll open the README.", turnComplete: false },
      { role: "assistant", content: "Completed the README steps." },
    ]);
    assert.deepEqual(warnings, [["invalid_tool_id", 2]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy tool compatibility preserves empty results and valid long JSON arguments", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "everme-cursor-legacy-"));
  const file = path.join(dir, "legacy.jsonl");
  const input = { command: "x".repeat(9000) };
  try {
    await writeFile(file, [
      { type: "tool_call", id: "native", name: "shell", arguments: JSON.stringify(input) },
      { type: "tool_result", tool_call_id: "native", content: "" },
      { type: "tool_result", tool_call_id: "native-long", content: "x".repeat(16001) },
    ].map(JSON.stringify).join("\n"));
    const messages = await readLastTurn(file);
    assert.equal(messages.length, 3);
    assert.deepEqual(JSON.parse(messages[0].toolCalls[0].arguments), input);
    assert.equal(messages[1].content, "");
    assert.equal(messages[2].content.length, 16001);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
