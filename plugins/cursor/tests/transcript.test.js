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
      await writeFile(file, "not-json\n{\"type\":\"reasoning\",\"text\":\"hidden\"}\n", "utf8");
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

// Cursor 3.16+ rewrote the transcript as a typed event stream. No full
// real sample with tool records exists yet (capture blocked on a usage
// limit), so the reader is deliberately lenient about field names and
// must warn on record types it does not recognise instead of silently
// dropping them — 2026-08-17 review item 1.1.10.
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
    assert.deepEqual(warned, ["future_record_kind"]);
  });

  test("synthesizes an id for a tool call record that carries none", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "everme-cursor-transcript-"));
    const file = path.join(dir, "no-id.jsonl");
    try {
      await writeFile(file, [
        JSON.stringify({ type: "user", message: { content: "question" } }),
        JSON.stringify({ type: "tool_call", tool_name: "shell", tool_input: { command: "ls" } }),
        "",
      ].join("\n"), "utf8");
      const [, call] = await readLastTurn(file);
      assert.equal(call.role, "assistant");
      assert.equal(call.toolCalls.length, 1);
      assert.equal(call.toolCalls[0].name, "shell");
      assert.equal(call.toolCalls[0].arguments, "{\"command\":\"ls\"}");
      assert.ok(call.toolCalls[0].id, "synthesized id must be non-empty");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
