import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = path.join(packageDir, "hooks", "scripts");
const tempDirs = [];
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Kimi Code shared hook runtime", () => {
  test("UserPromptSubmit sanitizes recall, uses topK 10, and omits profiles", async () => {
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
    assert.equal(requests[0].topK, 10);
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

  test("SessionEnd skips the write for a session below the message floor", async () => {
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
    assert.deepEqual(requests, []);
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

async function writeKimiTranscript(home, cwd, sessionId, events) {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  const dir = path.join(home, "sessions", `wd_my-kimi-project_${hash}`, sessionId, "agents", "main");
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
