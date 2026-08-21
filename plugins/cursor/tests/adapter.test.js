import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cursorAdapter } from "../src/adapter.js";

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
  test("maps only supported native lifecycle events", () => {
    assert.equal(cursorAdapter.mapEvent("sessionStart"), "SessionStart");
    assert.equal(cursorAdapter.mapEvent("stop"), "Stop");
    assert.equal(cursorAdapter.mapEvent("preCompact"), "PreCompact");
    assert.equal(cursorAdapter.mapEvent("postToolUse"), "PostToolUse");
    assert.equal(cursorAdapter.mapEvent("beforeSubmitPrompt"), "beforeSubmitPrompt");
  });

  test("normalizes the tool payload for postToolUse", async () => {
    const input = await cursorAdapter.normalizeInput({
      conversation_id: "cursor-conversation",
      generation_id: "cursor-generation",
      tool_name: "shell",
      tool_input: { command: "npm test" },
      tool_output: "all green",
    }, "postToolUse");
    assert.deepEqual(input.tool, {
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
      { ...input, tool: { name: "shell", input: { command: "npm test" }, output: "all green" } },
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
    const tool = { name: "shell", input: { command: "npm test" }, output: "all green" };

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
      { ...input, tool: { name: "shell", input: { command: "npm test" }, output: "exit 0" } },
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
