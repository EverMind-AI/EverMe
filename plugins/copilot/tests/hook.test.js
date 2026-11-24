import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { appendFile, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "node:test";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(packageDir, "tests", "fixtures", "copilot-events.jsonl");
const SESSION_ID = "s-copilot-1";
const tempDirs = [];
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  // A detached worker can still be writing its checkpoint here; retry the rm.
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

describe("everme-copilot hook CLI", () => {
  test("sessionStart returns the profile as top-level additionalContext", async () => {
    const server = await startServer(async (req, res) => {
      await readBody(req);
      respond(res, 200, {
        status: 0,
        result: { profile: { explicit_info: [{ category: "preference", description: "Prefers Rust" }] } },
      });
    });
    const { env, dir } = await runtimeEnv(server);
    const result = await runHook("sessionStart", { sessionId: SESSION_ID, source: "startup", cwd: "/w" }, env, [dir]);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.match(output.additionalContext, /^<everme_profile>/);
    assert.match(output.additionalContext, /Prefers Rust/);
  });

  test("userPromptSubmitted returns recall as additionalContext", async () => {
    const server = await startServer(async (req, res) => {
      await readBody(req);
      respond(res, 200, {
        status: 0,
        result: { items: [{ subject: "deploy window", episode: "Thursday afternoons" }], profiles: [] },
      });
    });
    const { env, dir } = await runtimeEnv(server);
    const result = await runHook("userPromptSubmitted", { sessionId: SESSION_ID, prompt: "when is our deploy window" }, env, [dir]);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.match(output.additionalContext, /everme_recall/);
    assert.match(output.additionalContext, /Thursday afternoons/);
  });

  test("agentStop uploads the newest turn without flushing, and sessionEnd adds nothing", async () => {
    const writes = [];
    const server = await startServer(async (req, res) => {
      const body = JSON.parse(await readBody(req));
      if (req.url === "/api/v1/mem/agent-memory") writes.push(body);
      respond(res, 200, { status: 0, result: { status: "accepted" } });
    });
    const { env, dir, transcript } = await runtimeEnv(server);
    const inline = { ...env, EVERME_COPILOT_INLINE: "1" };

    const stop = await runHook("agentStop", { sessionId: SESSION_ID, transcriptPath: transcript, stopReason: "end_turn", stop_hook_active: false }, inline, [dir]);
    assert.equal(stop.code, 0, stop.stderr);
    assert.equal(stop.stdout, "", "a capture hook must never write to the host's output channel");
    // sessionEnd carries no transcriptPath; the adapter derives the same file.
    const end = await runHook("sessionEnd", { sessionId: SESSION_ID, reason: "complete" }, inline, [dir]);
    assert.equal(end.code, 0, end.stderr);

    assert.equal(writes.length, 1);
    assert.equal(writes[0].conversationId, SESSION_ID);
    assert.equal(writes[0].flush, false);
    assert.equal(writes[0].channel, "hook");
    assert.equal(writes[0].deduplication, "client-native-id");
    assert.deepEqual(writes[0].messages.map((m) => m.role), ["user", "assistant", "tool", "tool", "assistant"]);
  });

  test("a later turn uploads only its own delta", async () => {
    const writes = [];
    const server = await startServer(async (req, res) => {
      const body = JSON.parse(await readBody(req));
      if (req.url === "/api/v1/mem/agent-memory") writes.push(body);
      respond(res, 200, { status: 0, result: { status: "accepted" } });
    });
    const { env, dir, transcript } = await runtimeEnv(server);
    const inline = { ...env, EVERME_COPILOT_INLINE: "1" };
    await runHook("agentStop", { sessionId: SESSION_ID, transcriptPath: transcript }, inline, [dir]);
    await appendFile(transcript, [
      { id: "e-30", timestamp: "2026-10-27T10:01:00.000Z", parentId: "e-23", type: "user.message", data: { content: "third prompt", messageId: "m-u3" } },
      { id: "e-31", timestamp: "2026-10-27T10:01:02.000Z", parentId: "e-30", type: "assistant.message", data: { messageId: "m-a5", content: "third reply" } },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");
    await runHook("agentStop", { sessionId: SESSION_ID, transcriptPath: transcript }, inline, [dir]);

    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1].messages.map((m) => m.content), ["third prompt", "third reply"]);
    assert.equal(writes[1].messages[1].turnComplete, true);
  });

  test("agentStop returns at once and the detached copy still uploads", async () => {
    let resolveWrite;
    const written = new Promise((resolve) => { resolveWrite = resolve; });
    const server = await startServer(async (req, res) => {
      const body = JSON.parse(await readBody(req));
      if (req.url === "/api/v1/mem/agent-memory") resolveWrite(body);
      respond(res, 200, { status: 0, result: { status: "accepted" } });
    });
    const { env, dir, transcript } = await runtimeEnv(server);
    const result = await runHook("agentStop", { sessionId: SESSION_ID, transcriptPath: transcript }, env, [dir]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "");
    const body = await Promise.race([
      written,
      new Promise((_, reject) => setTimeout(() => reject(new Error("detached upload never arrived")), 15000)),
    ]);
    assert.equal(body.conversationId, SESSION_ID);
  });

  test("reads credentials from the config dir passed after the event", async () => {
    const server = await startServer(async (req, res) => {
      await readBody(req);
      respond(res, 200, { status: 0, result: { items: [{ subject: "s", episode: "found via argv dir" }], profiles: [] } });
    });
    const { env, dir } = await runtimeEnv(server);
    delete env.EVERME_ENV_FILE_PATH;
    const result = await runHook("userPromptSubmitted", { sessionId: SESSION_ID, prompt: "which credentials file is used" }, env, [dir]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).additionalContext, /found via argv dir/);
  });

  test("an unconfigured host stays silent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "everme-copilot-"));
    tempDirs.push(dir);
    const env = cleanEnv({ EVERME_STATE_DIR: path.join(dir, "state"), EVERME_COPILOT_INLINE: "1" });
    const result = await runHook("agentStop", { sessionId: SESSION_ID, transcriptPath: FIXTURE }, env, [dir]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "");
  });

  test("a failing backend never blocks the turn and never logs the credential", async () => {
    const server = await startServer(async (req, res) => {
      await readBody(req);
      respond(res, 500, { status: 50000, error: "upstream exploded" });
    });
    const { env, dir, transcript } = await runtimeEnv(server);
    const result = await runHook("agentStop", { sessionId: SESSION_ID, transcriptPath: transcript }, { ...env, EVERME_COPILOT_INLINE: "1" }, [dir]);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /evt_aaaa/);
  });
});

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of ["EVERME_ENV_FILE_PATH", "EVERME_AGENT_TOKEN", "EVERME_AGENT_ID", "EVERME_API_BASE", "EVERCLI_COPILOT_CONFIG_DIR", "COPILOT_HOME"]) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

async function runtimeEnv(server) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "everme-copilot-"));
  tempDirs.push(dir);
  const sessionDir = path.join(dir, "session-state", SESSION_ID);
  await mkdir(sessionDir, { recursive: true });
  const transcript = path.join(sessionDir, "events.jsonl");
  await copyFile(FIXTURE, transcript);
  const envFile = path.join(dir, "everme.env");
  await writeFile(envFile, [
    `EVERME_API_BASE=http://127.0.0.1:${server.address().port}`,
    "EVERME_AGENT_ID=agt_copilot",
    "EVERME_AGENT_TOKEN=evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "",
  ].join("\n"), { mode: 0o600 });
  return {
    dir,
    transcript,
    env: cleanEnv({ EVERME_ENV_FILE_PATH: envFile, EVERME_STATE_DIR: path.join(dir, "state") }),
  };
}

function runHook(event, input, env, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/hook.js", event, ...extraArgs], { cwd: packageDir, env, stdio: ["pipe", "pipe", "pipe"] });
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

function respond(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
