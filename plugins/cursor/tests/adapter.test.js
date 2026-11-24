import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cursorAdapter } from "../src/adapter.js";
import { sanitizeSessionId } from "../../agent-sdk/src/hooks/state.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const transcriptPath = path.join(fixtures, "cursor-transcript.jsonl");
const toolEventsPath = path.join(fixtures, "cursor-transcript-tool-events.jsonl");
const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function newStateDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "everme-cursor-adapter-"));
  tempDirs.push(dir);
  return dir;
}

describe("Cursor hook adapter", () => {
  test("existing spool entries with missing name are rejected while valid neighbors survive", async () => {
    const stateDir = await newStateDir();
    const sessionId = "existing-spool";
    const event = { id: "old-call", input: "{}", output: "", ts: 1788672000000 };
    await writeFile(path.join(stateDir, `${sanitizeSessionId(sessionId)}.toolbuf.jsonl`), [event, { ...event, id: "valid-call", name: "Shell" }].map(value => JSON.stringify(value)).join("\n") + "\n");
    const warnings = [];
    const previous = process.stderr.write;
    let messages;
    process.stderr.write = value => { warnings.push(String(value)); return true; };
    try {
      messages = await cursorAdapter.readLastTurn({ sessionId }, { stateDir });
    } finally {
      process.stderr.write = previous;
    }
    assert.equal(messages.length, 2);
    assert.equal(messages[0].toolCalls[0].id, "valid-call");
    assert.equal(messages[1].toolCallId, "valid-call");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /invalid_tool_name: dropped_events=1/);
  });

  test("official postToolUse keeps native ID and exact empty or long tool bodies", async () => {
    for (const size of [0, 8000, 8001, 16001]) {
      const stateDir = await newStateDir();
      const raw = { conversation_id: "native-contract", generation_id: "generation-1", transcript_path: null, tool_use_id: `native-${size}`, tool_name: "Shell", tool_input: { command: "x".repeat(9000) }, tool_output: "x".repeat(size) };
      const input = cursorAdapter.normalizeInput(raw, "postToolUse");
      await cursorAdapter.bufferToolUse(input, { stateDir });
      const messages = await cursorAdapter.readLastTurn(input, { stateDir });
      assert.equal(messages.length, 2);
      assert.equal(messages[0].toolCalls[0].id, raw.tool_use_id);
      assert.deepEqual(JSON.parse(messages[0].toolCalls[0].arguments), raw.tool_input);
      assert.equal(messages[1].toolCallId, raw.tool_use_id);
      assert.equal(messages[1].content, raw.tool_output);
    }
  });

  test("malformed native tool fields are counted and excluded without invented pairs", async () => {
    for (const [field, value] of [["tool_use_id", undefined], ["tool_use_id", 42], ["tool_use_id", " "], ["tool_name", undefined], ["tool_name", 42], ["tool_input", undefined], ["tool_input", "{}"], ["tool_output", undefined], ["tool_output", {}]]) {
      const stateDir = await newStateDir();
      const warnings = [];
      const input = cursorAdapter.normalizeInput({ conversation_id: "native-contract", tool_use_id: "native-id", tool_name: "Shell", tool_input: {}, tool_output: "", [field]: value }, "postToolUse");
      const result = await cursorAdapter.bufferToolUse(input, { stateDir, warn: value => warnings.push(value) });
      assert.equal(result.count, 0, field);
      assert.deepEqual(await cursorAdapter.readLastTurn(input, { stateDir }), []);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /dropped_events=1/);
      assert.ok(warnings[0].length < 160);
    }
  });

  test("redaction keeps JSON syntax, large numbers, and the literal unknown name", async () => {
    const stateDir = await newStateDir();
    const token = "emk_" + "a".repeat(32);
    const output = '{ "n":9007199254740993, "url":"https://example.com/?X-Amz-Signature=abcdef", "token":"' + token + '" }';
    const input = cursorAdapter.normalizeInput({ conversation_id: "native-redaction", tool_use_id: "native-call", tool_name: "unknown", tool_input: { command: token }, tool_output: output }, "postToolUse");
    await cursorAdapter.bufferToolUse(input, { stateDir });
    const messages = await cursorAdapter.readLastTurn(input, { stateDir });
    assert.equal(messages[0].toolCalls[0].name, "unknown");
    assert.doesNotMatch(messages[0].toolCalls[0].arguments, new RegExp(token));
    assert.doesNotThrow(() => JSON.parse(messages[0].toolCalls[0].arguments));
    assert.match(messages[1].content, /9007199254740993/);
    assert.doesNotThrow(() => JSON.parse(messages[1].content));
    assert.doesNotMatch(messages[1].content, new RegExp(token));
    assert.doesNotMatch(messages[1].content, /Signature=abcdef/);
  });

  test("maps only supported native lifecycle events", () => {
    assert.equal(cursorAdapter.mapEvent("sessionStart"), "SessionStart");
    assert.equal(cursorAdapter.mapEvent("stop"), "Stop");
    assert.equal(cursorAdapter.mapEvent("preCompact"), "PreCompact");
    assert.equal(cursorAdapter.mapEvent("postToolUse"), "PostToolUse");
    assert.equal(cursorAdapter.mapEvent("beforeSubmitPrompt"), "beforeSubmitPrompt");
  });

  test("stores the turn at sessionEnd when no stop stored one", () => {
    // cursor-agent -p (2026.11.17) fires sessionEnd but never stop.
    assert.equal(cursorAdapter.mapEvent("sessionEnd"), "SessionEnd");
    assert.equal(cursorAdapter.storeAtSessionEndWithoutStop, true);
  });

  test("normalizes the tool payload for postToolUse", async () => {
    const input = await cursorAdapter.normalizeInput({
      conversation_id: "cursor-conversation",
      generation_id: "cursor-generation",
      tool_name: "shell",
      tool_use_id: "native-call",
      tool_input: { command: "npm test" },
      tool_output: "all green",
    }, "postToolUse");
    assert.deepEqual(input.tool, {
      id: "native-call",
      name: "shell",
      input: { command: "npm test" },
      output: "all green",
    });
  });

  test("normalizes official common input fields", async () => {
    assert.deepEqual(await cursorAdapter.normalizeInput({
      conversation_id: "cursor-conversation",
      generation_id: "cursor-generation",
      transcript_path: transcriptPath,
      workspace_roots: ["/repo", "/shared"],
      hook_event_name: "stop",
      cursor_version: "1.7.2",
    }, "stop"), {
      sessionId: "cursor-conversation",
      turnId: "cursor-generation",
      transcriptPath,
      workspaceRoots: ["/repo", "/shared"],
      cwd: "/repo",
      cursorVersion: "1.7.2",
    });
  });

  test("leaves the turn key empty when generation id is absent so dedup is disabled", async () => {
    const input = await cursorAdapter.normalizeInput({ conversation_id: "cursor-conversation" }, "stop");
    assert.equal(input.turnId, "");
  });

  test("reads the latest turn from the transcript", async () => {
    assert.deepEqual(await cursorAdapter.readLastTurn({ transcriptPath }), [
      { role: "user", content: "latest question" },
      { role: "assistant", content: "latest answer" },
    ]);
  });

  test("buffered tool events join the turn as call/result pairs after the user message", async () => {
    const stateDir = await newStateDir();
    const input = { sessionId: "cursor-conversation", turnId: "gen-1", transcriptPath };
    await cursorAdapter.bufferToolUse(
      { ...input, tool: { id: "native-call", name: "shell", input: { command: "npm test" }, output: "all green" } },
      { stateDir },
    );

    const messages = await cursorAdapter.readLastTurn(input, { stateDir });
    assert.equal(messages[0].role, "user");
    const call = messages[1];
    assert.equal(call.role, "assistant");
    assert.equal(call.toolCalls.length, 1);
    assert.equal(call.toolCalls[0].name, "shell");
    assert.equal(call.toolCalls[0].arguments, "{\"command\":\"npm test\"}");
    const result = messages[2];
    assert.equal(result.role, "tool");
    assert.equal(result.toolCallId, call.toolCalls[0].id);
    assert.equal(result.content, "all green");
    assert.deepEqual(messages[3], { role: "assistant", content: "latest answer" });

    const again = await cursorAdapter.readLastTurn(input, { stateDir });
    assert.ok(!again.some((message) => message.role === "tool"), "drain must consume the buffer");
  });

  // The spool is capped so a runaway turn cannot fill the disk, but a
  // capped call must leave a line behind: silently losing tool calls is
  // the exact failure mode this plugin exists to fix.
  test("a full spool drops the call with a warning, not in silence", async () => {
    const stateDir = await newStateDir();
    const warnings = [];
    const options = { stateDir, maxBytes: 1, warn: (line) => warnings.push(line) };
    const tool = { id: "native-call", name: "shell", input: { command: "npm test" }, output: "all green" };

    const first = await cursorAdapter.bufferToolUse(
      { sessionId: "cursor-conversation", turnId: "gen-1", tool },
      options,
    );
    assert.equal(first.count, 1, "the first append lands before the cap is hit");

    const second = await cursorAdapter.bufferToolUse(
      { sessionId: "cursor-conversation", turnId: "gen-1", tool },
      options,
    );
    assert.equal(second.count, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /tool call spool/i);
  });

  test("buffered tool events supersede tool records parsed from the transcript", async () => {
    const stateDir = await newStateDir();
    const input = { sessionId: "cursor-conversation", turnId: "gen-2", transcriptPath: toolEventsPath };
    await cursorAdapter.bufferToolUse(
      { ...input, tool: { id: "native-call", name: "shell", input: { command: "npm test" }, output: "exit 0" } },
      { stateDir },
    );

    const messages = await cursorAdapter.readLastTurn(input, { stateDir });
    const toolCalls = messages.flatMap((message) => message.toolCalls || []);
    assert.deepEqual(toolCalls.map((call) => call.name), ["shell"],
      "transcript tool records carry no outputs and must yield to the buffered pairs");
    assert.equal(messages.filter((message) => message.role === "tool").length, 1);
    assert.deepEqual(messages.filter((message) => message.role === "assistant" && message.content)
      .map((message) => message.content), ["running now", "all green"]);
  });

  test("without buffered events the transcript tool records are kept as fallback", async () => {
    const stateDir = await newStateDir();
    const messages = await cursorAdapter.readLastTurn(
      { sessionId: "cursor-conversation", transcriptPath: toolEventsPath },
      { stateDir },
    );
    const toolCalls = messages.flatMap((message) => message.toolCalls || []);
    assert.deepEqual(toolCalls.map((call) => call.name), ["shell", "read_file"]);
  });

  test("emits initial context only for sessionStart", () => {
    const block = "<everme_profile>facts</everme_profile>";
    assert.deepEqual(cursorAdapter.formatOutput("sessionStart", { block }), { additional_context: block });
    assert.deepEqual(cursorAdapter.formatOutput("stop", { block }), {});
    assert.deepEqual(cursorAdapter.formatOutput("preCompact", { block }), {});
    assert.deepEqual(cursorAdapter.formatOutput("beforeSubmitPrompt", { block }), {});
    assert.deepEqual(cursorAdapter.formatOutput("sessionStart", { block: "" }), {});
  });

  test("uses the Cursor credential file by default", () => {
    const previous = process.env.EVERME_ENV_FILE_PATH;
    delete process.env.EVERME_ENV_FILE_PATH;
    try {
      assert.equal(cursorAdapter.envFile(), path.join(os.homedir(), ".cursor", "everme.env"));
    } finally {
      if (previous === undefined) delete process.env.EVERME_ENV_FILE_PATH;
      else process.env.EVERME_ENV_FILE_PATH = previous;
    }
  });
});

describe("L1-2 population", () => {
  test("cursor is a per-turn writer", () => {
    // One host event maps to Stop and generation_id keys the turn, so cursor
    // is in both halves of L1-2: it claims channel="hook" and it reports
    // lost turns. Dropping this declaration would take it out of the
    // numerator while its losses kept landing in the denominator.
    assert.equal(cursorAdapter.turnBoundary, "stop");
  });
});
