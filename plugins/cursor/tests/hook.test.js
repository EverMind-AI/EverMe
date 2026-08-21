import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(packageDir, "tests", "fixtures", "cursor-transcript.jsonl");
const tempDirs = [];
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("everme-cursor hook CLI", () => {
  test("stop writes the latest turn and preCompact sends a flush-only request", async () => {
    const requests = [];
    const server = await startServer(async (req, res) => {
      requests.push({ path: req.url, body: JSON.parse(await readBody(req)) });
      respond(res, 200, { status: 0, result: { flushed: true } });
    });
    const runtime = await runtimeEnv(server, "test-agent-token");
    const baseInput = {
      conversation_id: "cursor-conversation",
      generation_id: "cursor-generation",
      transcript_path: fixture,
      workspace_roots: ["/repo"],
    };

    const stop = await runHookProcess("stop", { ...baseInput, hook_event_name: "stop" }, runtime.env);
    const compact = await runHookProcess(
      "preCompact",
      { ...baseInput, hook_event_name: "preCompact", generation_id: "compact-generation" },
      runtime.env,
    );

    assert.equal(stop.code, 0);
    assert.equal(stop.stdout, "");
    assert.match(stop.stderr, /saveAgentMemory ok: .*requestId=[0-9a-f-]{36}/,
      "stderr must carry the save line with its trace id");
    assert.equal(compact.code, 0);
    assert.equal(compact.stdout, "");
    assert.match(compact.stderr, /requestId=[0-9a-f-]{36}/);
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.path === "/api/v1/mem/agent-memory"));
    assert.deepEqual(requests[0].body.messages.map(({ role, content }) => ({ role, content })), [
      { role: "user", content: "latest question" },
      { role: "assistant", content: "latest answer" },
    ]);
    assert.equal(requests[0].body.flush, false);
    assert.deepEqual(requests[1].body, {
      conversationId: "cursor-conversation",
      messages: [],
      flush: true,
    });
  });

  test("postToolUse spools locally without network and stop attaches the spooled calls", async () => {
    const requests = [];
    const server = await startServer(async (req, res) => {
      requests.push({ path: req.url, body: JSON.parse(await readBody(req)) });
      respond(res, 200, { status: 0, result: { flushed: true } });
    });
    const runtime = await runtimeEnv(server, "test-agent-token");
    const baseInput = {
      conversation_id: "cursor-tools",
      generation_id: "cursor-tools-generation",
      transcript_path: fixture,
    };

    const post = await runHookProcess("postToolUse", {
      ...baseInput,
      hook_event_name: "postToolUse",
      tool_name: "shell",
      tool_input: { command: "npm test" },
      tool_output: "all green",
    }, runtime.env);
    assert.equal(post.code, 0);
    assert.equal(post.stdout, "");
    assert.equal(requests.length, 0, "postToolUse must not touch the network");

    const stop = await runHookProcess("stop", { ...baseInput, hook_event_name: "stop" }, runtime.env);
    assert.equal(stop.code, 0);
    assert.equal(requests.length, 1);
    const messages = requests[0].body.messages;
    assert.equal(messages[0].role, "user");
    assert.equal(messages[1].role, "assistant");
    assert.equal(messages[1].toolCalls[0].name, "shell");
    assert.equal(messages[1].toolCalls[0].arguments, "{\"command\":\"npm test\"}");
    assert.equal(messages[2].role, "tool");
    assert.equal(messages[2].toolCallId, messages[1].toolCalls[0].id);
    assert.equal(messages[2].content, "all green");
    assert.equal(messages[3].role, "assistant");
    assert.equal(messages[3].content, "latest answer");
  });

  test("backend errors fail open and redact the credential", async () => {
    const token = ["ev", "t_", "d".repeat(32)].join("");
    const server = await startServer(async (_req, res) => {
      respond(res, 401, { status: 30101, error: `expired ${token}` });
    });
    const runtime = await runtimeEnv(server, token);

    const result = await runHookProcess("stop", {
      conversation_id: "cursor-failed",
      generation_id: "cursor-failed-generation",
      transcript_path: fixture,
    }, runtime.env);

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, new RegExp(token));
    assert.match(result.stderr, /REDACTED/);
    assert.equal(result.stderr.match(/\n/g)?.length, 1);
  });
});

async function runtimeEnv(server, token) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "everme-cursor-"));
  tempDirs.push(dir);
  const address = server.address();
  const envFile = path.join(dir, "everme.env");
  await writeFile(envFile, [
    `EVERME_API_BASE=http://127.0.0.1:${address.port}`,
    "EVERME_AGENT_ID=agt_cursor",
    `EVERME_AGENT_TOKEN=${token}`,
    `EVERME_STATE_DIR=${path.join(dir, "state")}`,
    "",
  ].join("\n"), { mode: 0o600 });
  return {
    env: {
      ...process.env,
      EVERME_ENV_FILE_PATH: envFile,
      EVERME_AGENT_TOKEN: "",
      EVERME_AGENT_ID: "",
      EVERME_API_BASE: "",
      EVERME_STATE_DIR: "",
    },
  };
}

function runHookProcess(event, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/hook.js", "hook", event], {
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

function respond(res, statusCode, body) {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
