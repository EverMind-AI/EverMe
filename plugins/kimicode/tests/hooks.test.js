import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { kimiCodeAdapter } from "../hooks/scripts/lib/adapter.js";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = path.join(packageDir, "hooks", "scripts");
const tempDirs = [];
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Kimi Code shared hook runtime", () => {
  test("normalization preserves native session IDs and rejects unusable IDs without a fallback", () => {
    for (const sessionId of ["session-native", " session-native "]) {
      assert.equal(kimiCodeAdapter.normalizeInput({ session_id: sessionId }, "SessionEnd").sessionId, sessionId);
    }
    for (const sessionId of [undefined, null, "", " \t ", 42, {}, []]) {
      assert.equal(kimiCodeAdapter.normalizeInput({ session_id: sessionId }, "SessionEnd").sessionId, "");
    }
  });

  for (const [event, script] of [
    ["SessionEnd", "session-summary.mjs"],
    ["SubagentStop", "store-subagent-memories.mjs"],
  ]) {
    test(`${event} skips missing or invalid session IDs before any HTTP request`, async () => {
      const requests = [];
      const server = await startServer(async (req, res) => {
        requests.push(JSON.parse(await readBody(req)));
        respond(res, { status: 0, result: { flushed: true } });
      });
      const env = await hookEnv(server);
      for (const sessionId of [undefined, null, "", " \t ", 42, {}, []]) {
        const result = await runHook(script, { session_id: sessionId, cwd: "/repo/my-kimi-project" }, env);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stdout, "");
        assert.equal(requests.length, 0);
        const stage = event === "SessionEnd" ? "boundary-flush" : "store";
        assert.equal(result.stderr, `[everme] ${stage} stage=skip reason=missing_session_id\n`);
      }
    });
  }

  test("UserPromptSubmit sanitizes recall, uses topK 5, and omits profiles", async () => {
    const requests = [];
    const server = await startServer(async (req, res) => {
      requests.push(JSON.parse(await readBody(req)));
      respond(res, {
        status: 0,
        result: {
          items: [{ type: "episodic_memory", summary: "kept episode", score: 0.8 }],
          profiles: [{ profileData: { embed_text: "hidden passive profile" } }],
          rawMessages: [],
          agentMemory: { cases: [], skills: [] },
        },
      });
    });
    const env = await hookEnv(server);

    const result = await runHook("inject-memories.mjs", {
      session_id: "kimi-session",
      prompt: "/ask <everme_profile>old</everme_profile> 请回忆 OAuth 方案",
    }, env);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests[0].query, "请回忆 OAuth 方案");
    assert.equal(requests[0].topK, 5);
    const output = JSON.parse(result.stdout);
    assert.match(output.message, /kept episode/);
    assert.doesNotMatch(output.message, /hidden passive profile/);
  });

  test("SessionEnd flushes the whole session in a single write", async () => {
    const requests = [];
    const server = await startServer(async (req, res) => {
      requests.push(JSON.parse(await readBody(req)));
      respond(res, { status: 0, result: { flushed: true } });
    });
    const env = await hookEnv(server);
    const cwd = "/repo/my-kimi-project";
    const sessionId = "session-end";
    await writeKimiTranscript(env.KIMI_CODE_HOME, cwd, sessionId, [
      userEvent("remember this turn", 1749001000000),
      assistantEvents("noted, saving it", 1749001001000),
      userEvent("and one more thing", 1749001002000),
      assistantEvents("got that too", 1749001003000),
    ].flat());

    const result = await runHook("session-summary.mjs", { session_id: sessionId, cwd }, env);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].conversationId, sessionId);
    assert.equal(requests[0].flush, true);
    assert.deepEqual(
      requests[0].messages.map((m) => m.role),
      ["user", "assistant", "user", "assistant"],
    );
  });

  test("a re-fired SessionEnd uploads nothing; a resumed session uploads only the delta", async () => {
    const requests = [];
    const server = await startServer(async (req, res) => {
      requests.push(JSON.parse(await readBody(req)));
      respond(res, { status: 0, result: { flushed: true } });
    });
    const env = await hookEnv(server);
    const cwd = "/repo/my-kimi-project";
    const sessionId = "session-refire";
    const initialEvents = [
      userEvent("remember this turn", 1749001000000),
      assistantEvents("noted, saving it", 1749001001000),
    ].flat();
    await writeKimiTranscript(env.KIMI_CODE_HOME, cwd, sessionId, initialEvents);

    const first = await runHook("session-summary.mjs", { session_id: sessionId, cwd }, env);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(requests.length, 1);

    // Re-fired SessionEnd over the unchanged session: nothing new to upload.
    const refired = await runHook("session-summary.mjs", { session_id: sessionId, cwd }, env);
    assert.equal(refired.code, 0, refired.stderr);
    assert.equal(requests.length, 1, "second SessionEnd must not re-upload the transcript");

    // Session resumed, two more messages appended: only the delta uploads.
    await writeKimiTranscript(env.KIMI_CODE_HOME, cwd, sessionId, [
      ...initialEvents,
      userEvent("one more thing", 1749001002000),
      assistantEvents("done", 1749001003000),
    ].flat());
    const resumed = await runHook("session-summary.mjs", { session_id: sessionId, cwd }, env);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].messages.map((m) => m.role), ["user", "assistant"]);
    assert.match(requests[1].messages[0].content, /one more thing/);
    assert.equal(requests[1].flush, true);
  });

  test("SessionEnd persists a single visible root user message", async () => {
    const requests = [];
    const server = await startServer(async (req, res) => {
      requests.push(JSON.parse(await readBody(req)));
      respond(res, { status: 0, result: { flushed: true } });
    });
    const env = await hookEnv(server);
    const cwd = "/repo/my-kimi-project";
    const sessionId = "session-thin";
    await writeKimiTranscript(env.KIMI_CODE_HOME, cwd, sessionId, userEvent("only one message", 1749001000000));

    const result = await runHook("session-summary.mjs", { session_id: sessionId, cwd }, env);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].messages, [{ role: "user", timestamp: 1749001000000, content: "only one message" }]);
  });

  test("SessionEnd persists a single root assistant without fabricating a user", async () => {
    const requests = [];
    const server = await startServer(async (req, res) => {
      requests.push(JSON.parse(await readBody(req)));
      respond(res, { status: 0, result: { flushed: true } });
    });
    const env = await hookEnv(server);
    const cwd = "/repo/my-kimi-project";
    const sessionId = "session-single-assistant";
    await writeKimiTranscript(env.KIMI_CODE_HOME, cwd, sessionId, assistantEvents("Finished the work", 1749001000000));
    const result = await runHook("session-summary.mjs", { session_id: sessionId, cwd }, env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].messages, [{ role: "assistant", timestamp: 1749001000000, content: "Finished the work" }]);
  });

  test("SessionEnd compresses an oversized root task without splitting its tool pair", async () => {
    const requests = [];
    const server = await startServer(async (req, res) => {
      requests.push(JSON.parse(await readBody(req)));
      respond(res, { status: 0, result: { flushed: true } });
    });
    const env = await hookEnv(server);
    const cwd = "/repo/my-kimi-project";
    const sessionId = "session-large-task";
    await writeKimiTranscript(env.KIMI_CODE_HOME, cwd, sessionId, [
      userEvent("inspect", 1749001000000),
      { type: "context.append_loop_event", time: 1749001001000, event: { type: "tool.call", turnId: "large", step: 1, toolCallId: "native-large", name: "Shell", args: { command: "pwd" } } },
      { type: "context.append_loop_event", time: 1749001002000, event: { type: "tool.result", turnId: "large", step: 1, toolCallId: "native-large", result: { output: "x".repeat(320000) + "\nexit code: 0" } } },
      ...assistantEvents("done", 1749001003000),
    ]);
    const result = await runHook("session-summary.mjs", { session_id: sessionId, cwd }, env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests.length, 1);
    const messages = requests[0].messages;
    assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "tool", "assistant"]);
    assert.equal(messages[2].toolCallId, messages[1].toolCalls[0].id);
    assert.ok(Buffer.byteLength(messages[2].content) <= 4096);
    assert.match(messages[2].content, /exit code: 0$/);
    assert.equal(requests[0].flush, true);
  });

  test("SubagentStop and SessionEnd skip userless child trajectories", async () => {
    const requests = [];
    const server = await startServer(async (req, res) => {
      requests.push(JSON.parse(await readBody(req)));
      respond(res, { status: 0, result: { flushed: true } });
    });
    const env = await hookEnv(server);
    const cwd = "/repo/my-kimi-project";
    const sessionId = "session-subagent";
    await writeKimiTranscript(env.KIMI_CODE_HOME, cwd, sessionId, [
      userEvent("task wrapper", 1749001000000),
      {
        type: "context.append_loop_event",
        time: 1749001001000,
        event: { type: "tool.call", turnId: "child", step: 1, toolCallId: "child-call", name: "Shell", args: { command: "pwd" } },
      },
      {
        type: "context.append_loop_event",
        time: 1749001002000,
        event: { type: "tool.result", turnId: "child", step: 1, toolCallId: "child-call", result: { output: "/repo" } },
      },
      ...assistantEvents("child answer", 1749001003000),
    ], "child-1");

    const payload = { session_id: sessionId, cwd, hook_event_name: "SubagentStop" };
    const first = await runHook("store-subagent-memories.mjs", payload, env);
    const duplicate = await runHook("store-subagent-memories.mjs", payload, env);
    const boundary = await runHook("session-summary.mjs", { session_id: sessionId, cwd }, env);

    assert.equal(first.code, 0, first.stderr);
    assert.equal(duplicate.code, 0, duplicate.stderr);
    assert.equal(boundary.code, 0, boundary.stderr);
    assert.equal(requests.length, 0);
    assert.match(first.stderr, /subagent_without_user/);
    assert.match(boundary.stderr, /subagent_without_user/);
  });

  test("SubagentStop skips a child containing only its final assistant message", async () => {
    const requests = [];
    const server = await startServer(async (req, res) => {
      requests.push(JSON.parse(await readBody(req)));
      respond(res, { status: 0, result: { flushed: true } });
    });
    const env = await hookEnv(server);
    const cwd = "/repo/my-kimi-project";
    const sessionId = "session-single-child-answer";
    await writeKimiTranscript(
      env.KIMI_CODE_HOME,
      cwd,
      sessionId,
      assistantEvents("child final answer", 1749001000000),
      "child-1",
    );

    const result = await runHook(
      "store-subagent-memories.mjs",
      { session_id: sessionId, cwd, hook_event_name: "SubagentStop" },
      env,
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests.length, 0);
    assert.match(result.stderr, /subagent_without_user/);
  });
});

async function hookEnv(server) {
  const home = await mkdtemp(path.join(os.tmpdir(), "everme-kimi-hooks-"));
  tempDirs.push(home);
  return {
    ...process.env,
    KIMI_CODE_HOME: home,
    EVERME_ENV_FILE_PATH: path.join(home, "missing.env"),
    EVERME_API_BASE: `http://127.0.0.1:${server.address().port}`,
    EVERME_AGENT_ID: "agt_kimi",
    EVERME_AGENT_TOKEN: "test-agent-token",
    EVERME_STATE_DIR: path.join(home, "state"),
  };
}

async function writeKimiTranscript(home, cwd, sessionId, events, agentId = "main") {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  const dir = path.join(home, "sessions", `wd_my-kimi-project_${hash}`, sessionId, "agents", agentId);
  await mkdir(dir, { recursive: true });
  const lines = (Array.isArray(events) ? events : [events]).map((event) => JSON.stringify(event)).join("\n");
  await writeFile(path.join(dir, "wire.jsonl"), `${lines}\n`);
}

function userEvent(text, time) {
  return {
    type: "context.append_message",
    time,
    message: { role: "user", origin: { kind: "user" }, content: [{ type: "text", text }] },
  };
}

function assistantEvents(text, time) {
  return [
    {
      type: "context.append_loop_event",
      time,
      event: { type: "content.part", turnId: `turn-${time}`, step: 1, part: { type: "text", text } },
    },
    {
      type: "context.append_loop_event",
      time,
      event: { type: "step.end", turnId: `turn-${time}`, step: 1 },
    },
  ];
}

function runHook(script, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(scriptsDir, script)], {
      cwd: packageDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

async function startServer(handler) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return server;
}

async function readBody(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function respond(res, body) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

describe("L1-2 population", () => {
  test("kimicode is NOT a per-turn writer", async () => {
    // It uploads the whole root session at SessionEnd and whole subagent
    // sessions through the batch path — there is no per-turn Stop writer, so
    // it can neither claim the hook channel nor report a lost turn. Declaring
    // "stop" would put whole-session uploads in L1-2's numerator as one turn
    // each and start reporting losses against them.
    const { kimiCodeAdapter } = await import("../hooks/scripts/lib/adapter.js");
    assert.equal(kimiCodeAdapter.turnBoundary, undefined);
  });
});

// Kimi Code 2.6 sends the UserPromptSubmit prompt as content parts, not a
// string. Recall needs the text of those parts, or it skips silently.
test("normalizeInput reads the text of a prompt sent as content parts", async () => {
  const { kimiCodeAdapter } = await import("../hooks/scripts/lib/adapter.js");
  const parts = [{ type: "text", text: "What is the kimi tui code?" }, { type: "image", source: "x" }, { type: "text", text: "Answer briefly." }];
  assert.equal(kimiCodeAdapter.normalizeInput({ session_id: "s", prompt: parts }, "UserPromptSubmit").prompt,
    "What is the kimi tui code?\nAnswer briefly.");
  assert.equal(kimiCodeAdapter.normalizeInput({ session_id: "s", prompt: "plain" }, "UserPromptSubmit").prompt, "plain");
});
