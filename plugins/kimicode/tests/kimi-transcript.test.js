import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { batchAgentMessages } from "../../agent-sdk/src/agent-batches.js";
import { extractAgentMessages, readLastTurn, readSession, wirePath } from "../hooks/scripts/lib/kimi-transcript.js";

test("marks only final assistant text from native end_turn as complete", () => {
  for (const finishReason of ["end_turn", "tool_use", "max_tokens", "interrupted"]) {
    const rows = toolResultLines("file found").map(JSON.parse);
    rows.at(-1).event.finishReason = finishReason;
    const messages = extractAgentMessages(rows.map(JSON.stringify));
    assert.equal(messages.at(-1).turnComplete, finishReason === "end_turn" ? true : undefined);
    assert.equal(messages.at(-1).timestamp, 1788688806000);
    assert.ok(messages.slice(0, -1).every(message => message.turnComplete === undefined));
  }
});

test("does not mark a tool preamble or invent final text when tools stop the turn", () => {
  const rows = toolResultLines("file found").map(JSON.parse).slice(0, 5);
  const preamble = { type: "context.append_loop_event", time: 1788688801500,
    event: { type: "content.part", turnId: "turn_read", step: 1, part: { type: "text", text: "Reading now" } } };
  rows.splice(2, 0, preamble);
  rows.at(-1).event.finishReason = "end_turn";
  const messages = extractAgentMessages(rows.map(JSON.stringify));
  assert.deepEqual(messages.map(message => message.role), ["user", "assistant", "assistant", "tool"]);
  assert.equal(messages[1].content, "Reading now");
  assert.ok(messages.every(message => message.turnComplete === undefined));
  const unfinished = extractAgentMessages(toolResultLines("file found").slice(0, -1));
  assert.equal(unfinished.at(-1).content, "Read complete");
  assert.equal(unfinished.at(-1).turnComplete, undefined);
});

test("prefers completed child turns over a later tool pair under a test batch budget", () => {
  const first = toolResultLines("first result");
  const second = toolResultLines("second result").map(line => {
    const row = JSON.parse(line);
    row.time += 10000;
    if (row.event?.turnId) row.event.turnId = "turn_second";
    if (row.event?.toolCallId) row.event.toolCallId = "call_second";
    return JSON.stringify(row);
  });
  const messages = extractAgentMessages([...first, ...second], { subagent: true });
  assert.deepEqual(messages.map(message => message.role), ["assistant", "tool", "assistant", "assistant", "tool", "assistant"]);
  assert.deepEqual(batchAgentMessages(messages, 5, messages).map(batch => batch.length), [3, 3]);
});

test("serializes native parsed argument values once", () => {
  for (const args of [{ path: "file.txt" }, "command: pwd", '{"path":"file.txt"}', null, false, 42, ["file.txt"]]) {
    const rows = toolResultLines("validation result").map(line => JSON.parse(line));
    const event = rows.find(row => row.event?.type === "tool.call").event;
    event.args = args;
    event.uuid = "event-uuid-not-call-id";
    const result = rows.find(row => row.event?.type === "tool.result").event;
    result.parentUuid = event.uuid;
    const messages = extractAgentMessages(rows.map(row => JSON.stringify(row)));
    assert.deepEqual(JSON.parse(messages[1].toolCalls[0].arguments), args);
    assert.equal(messages[1].toolCalls[0].id, "call_read");
    assert.equal(messages[2].toolCallId, "call_read");
  }
});

test("drops missing native tool IDs instead of using event UUIDs", () => {
  for (const id of [undefined, "  ", 42]) {
    const rows = toolResultLines("Private source output").map(line => JSON.parse(line));
    Object.assign(rows.find(row => row.event?.type === "tool.call").event, { toolCallId: id, uuid: "event-uuid" });
    Object.assign(rows.find(row => row.event?.type === "tool.result").event, { toolCallId: id, parentUuid: "event-uuid" });
    const diagnostics = [];
    const messages = extractAgentMessages(rows.map(row => JSON.stringify(row)), { diagnostic: value => diagnostics.push(value) });
    assert.deepEqual(messages.map(message => message.role), ["user", "assistant"]);
    assert.deepEqual(diagnostics, ["[everme] kimicode parse dropped_invalid_call_id=1 dropped_invalid_result_id=1 dropped_invalid_name=0 dropped_name_results=0"]);
  }
});

test("drops invalid names and only uniquely associated results", () => {
  const rows = toolResultLines("Private source output").map(line => JSON.parse(line));
  const callRow = rows.find(row => row.event?.type === "tool.call");
  delete callRow.event.name;
  const diagnostics = [];
  assert.deepEqual(extractAgentMessages(rows.map(row => JSON.stringify(row)), { diagnostic: value => diagnostics.push(value) }).map(message => message.role), ["user", "assistant"]);
  assert.deepEqual(diagnostics, ["[everme] kimicode parse dropped_invalid_call_id=0 dropped_invalid_result_id=0 dropped_invalid_name=1 dropped_name_results=1"]);
  const duplicate = structuredClone(callRow);
  duplicate.event.name = "unknown";
  rows.splice(rows.indexOf(callRow) + 1, 0, duplicate);
  const messages = extractAgentMessages(rows.map(row => JSON.stringify(row)), { diagnostic() {} });
  assert.deepEqual(messages.map(message => message.role), ["user", "assistant", "tool", "assistant"]);
  assert.equal(messages[1].toolCalls[0].name, "unknown");
});

test("preserves empty, literal, and long tool result content with its native pair", async (t) => {
  const cases = [
    ["empty read", ""],
    ["literal placeholder", "tool result"],
    ...[8000, 8001, 16001].map((size) => [`${size} characters`, readOutput(size)]),
  ];
  for (const [name, output] of cases) {
    await t.test(name, () => {
      const messages = extractAgentMessages(toolResultLines(output));
      assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "tool", "assistant"]);
      assert.equal(messages[1].toolCalls.length, 1);
      assert.equal(messages[1].toolCalls[0].id, "call_read");
      assert.equal(messages[2].toolCallId, "call_read");
      assert.equal(messages[2].content, output);
      assert.equal(messages[2].timestamp, 1788688803000);
      assert.equal(messages[3].content, "Read complete");
    });
  }
});

function readOutput(size) {
  let output = "";
  for (let line = 1; output.length < size; line++) {
    const prefix = `${line > 1 ? "\n" : ""}${line}\t`;
    const width = Math.min(1000, size - output.length - prefix.length);
    output += prefix + "文".repeat(width);
  }
  return output;
}

function toolResultLines(output) {
  return [
    { type: "context.append_message", message: { role: "user", origin: { kind: "user" }, content: [{ type: "text", text: "Read the file" }] } },
    { type: "context.append_loop_event", event: { type: "step.begin", uuid: "step_read", turnId: "turn_read", step: 1 } },
    { type: "context.append_loop_event", event: { type: "tool.call", stepUuid: "step_read", turnId: "turn_read", step: 1, toolCallId: "call_read", name: "Read", args: { path: "output.log" } } },
    { type: "context.append_loop_event", event: { type: "tool.result", toolCallId: "call_read", result: { output } } },
    { type: "context.append_loop_event", event: { type: "step.end", uuid: "step_read", turnId: "turn_read", step: 1, finishReason: "tool_calls" } },
    { type: "context.append_loop_event", event: { type: "step.begin", uuid: "step_answer", turnId: "turn_read", step: 2 } },
    { type: "context.append_loop_event", event: { type: "content.part", stepUuid: "step_answer", turnId: "turn_read", step: 2, part: { type: "text", text: "Read complete" } } },
    { type: "context.append_loop_event", event: { type: "step.end", uuid: "step_answer", turnId: "turn_read", step: 2, finishReason: "end_turn" } },
  ].map((row, index) => JSON.stringify({ ...row, time: 1788688800000 + index * 1000 }));
}

// Kimi Code names each session's bucket dir `wd_<slug>_<hash12>` where hash12 =
// sha256(cwd)[:12] and the slug PRESERVES hyphens (its encodeWorkDirKey). The
// plugin used to reconstruct the slug with its own rule (hyphens -> "_"), so for
// any cwd whose basename has a hyphen the reconstructed path missed the real
// dir, readWireLines returned [], and the write hook silently persisted nothing.
// The hash12 suffix is identical on both sides, so locating the bucket by hash
// is drift-proof.
test("readLastTurn locates wire.jsonl under a hyphen-slug workdir dir (encodeWorkDirKey drift)", async () => {
  const home = mkdtempSync(join(tmpdir(), "kimi-home-"));
  const prevHome = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = home;
  try {
    const cwd = "/Users/x/code/my-proj"; // hyphen in basename
    const sessionId = "session_abc-123";
    const hash12 = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
    // Kimi keeps the hyphen: wd_my-proj_<hash12> (NOT wd_my_proj_<hash12>).
    const dir = join(home, "sessions", `wd_my-proj_${hash12}`, sessionId, "agents", "main");
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      type: "context.append_message",
      time: 1700000000000,
      message: { role: "user", origin: { kind: "user" }, content: [{ type: "text", text: "hello glob" }] },
    });
    writeFileSync(join(dir, "wire.jsonl"), line + "\n");

    const tail = await readLastTurn({ sessionId, cwd });
    assert.equal(tail.length, 1, "should locate the transcript despite slug drift");
    assert.equal(tail[0].role, "user");
    assert.equal(tail[0].content, "hello glob");
  } finally {
    if (prevHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// A per-turn writer uploads only the last turn (thin), which produces agent
// cases but rarely an episode. The SessionEnd handler needs the WHOLE session
// so the backend has enough coherent context to extract an episodic memory.
// readSession returns every turn; lastTurn returns only the final one.
test("readSession returns the full multi-turn session, unlike lastTurn", async () => {
  const home = mkdtempSync(join(tmpdir(), "kimi-home-"));
  const prev = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = home;
  try {
    const cwd = "/Users/x/code/proj";
    const sessionId = "session_multi";
    const hash12 = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
    const dir = join(home, "sessions", `wd_proj_${hash12}`, sessionId, "agents", "main");
    mkdirSync(dir, { recursive: true });
    const L = [
      { type: "context.append_message", time: 1700000000000, message: { role: "user", origin: { kind: "user" }, content: [{ type: "text", text: "first question" }] } },
      { type: "context.append_loop_event", time: 1700000001000, event: { type: "content.part", turnId: 0, step: 1, part: { type: "text", text: "first answer" } } },
      { type: "context.append_loop_event", time: 1700000001500, event: { type: "step.end", turnId: 0, step: 1 } },
      { type: "context.append_message", time: 1700000002000, message: { role: "user", origin: { kind: "user" }, content: [{ type: "text", text: "second question" }] } },
      { type: "context.append_loop_event", time: 1700000003000, event: { type: "content.part", turnId: 1, step: 1, part: { type: "text", text: "second answer" } } },
      { type: "context.append_loop_event", time: 1700000003500, event: { type: "step.end", turnId: 1, step: 1 } },
    ].map((o) => JSON.stringify(o)).join("\n");
    writeFileSync(join(dir, "wire.jsonl"), L + "\n");

    const full = await readSession({ sessionId, cwd });
    const tail = await readLastTurn({ sessionId, cwd });
    assert.equal(full.length, 4, "full session = 2 user + 2 assistant");
    assert.equal(full.filter((m) => m.role === "user").length, 2, "both user turns present");
    assert.equal(full[0].content, "first question", "session starts at the first turn");
    assert.ok(full.length > tail.length, "readSession must be a superset of the last turn");
  } finally {
    if (prev === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("drops injected pseudo-users without dropping trusted assistant/tool activity", () => {
  const lines = [
    { type: "context.append_loop_event", time: 1, event: { type: "content.part", turnId: 0, step: 1, part: { type: "text", text: "orphan answer" } } },
    { type: "context.append_loop_event", time: 2, event: { type: "tool.call", turnId: 0, step: 1, toolCallId: "orphan", name: "shell", args: {} } },
    { type: "context.append_message", time: 3, message: { role: "user", origin: { kind: "injection" }, content: [{ type: "text", text: "injected memory" }] } },
    { type: "context.append_message", time: 4, message: { role: "user", origin: { kind: "user" }, content: [{ type: "text", text: "real question" }] } },
    { type: "context.append_loop_event", time: 5, event: { type: "content.part", turnId: 1, step: 1, part: { type: "text", text: "real answer" } } },
    { type: "context.append_loop_event", time: 6, event: { type: "step.end", turnId: 1, step: 1 } },
  ].map((row) => JSON.stringify(row));

  const messages = extractAgentMessages(lines);
  assert.deepEqual(messages.map(({ role, content }) => ({ role, content })), [
    { role: "assistant", content: "orphan answer" },
    { role: "assistant", content: undefined },
    { role: "user", content: "real question" },
    { role: "assistant", content: "real answer" },
  ]);
  assert.equal(messages[1].toolCalls[0].name, "shell");
});

// Kimi Code hands a UserPromptSubmit hook's output back as its own text part
// of the user's message, wrapped in <hook_result>. That part is our recall
// block, not the user's words; uploading it feeds memory back into memory.
test("drops the hook_result part Kimi adds to a user message", () => {
  const rows = [
    { type: "context.append_message", time: 1700000000000, message: { role: "user", origin: { kind: "user" }, content: [
      { type: "text", text: '<hook_result hook_event="UserPromptSubmit">\n<everos_recall>\n## Relevant memory\n- [memory] old code\n</everos_recall>\n</hook_result>' },
      { type: "text", text: "What is the kimi tui code?" },
    ] } },
  ];
  const messages = extractAgentMessages(rows.map((row) => JSON.stringify(row)));
  assert.deepEqual(messages.map((m) => m.content), ["What is the kimi tui code?"]);
});

test("keeps a user part that only quotes hook_result", () => {
  const text = "why does <hook_result> show up in my prompt?";
  const rows = [{ type: "context.append_message", time: 1700000000000, message: { role: "user", origin: { kind: "user" }, content: [{ type: "text", text }] } }];
  assert.deepEqual(extractAgentMessages(rows.map((row) => JSON.stringify(row))).map((m) => m.content), [text]);
});
