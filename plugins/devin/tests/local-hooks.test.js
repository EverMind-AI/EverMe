import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { devinAdapter } from "../src/adapter.js";
import { takeStopPayload, writeStopPayload } from "../src/stop-payload.js";
import { runWorker } from "../bin/worker.js";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];
const servers = [];

// Stdin captured from Devin Desktop 3.14.30819 (Devin Local) with a probe
// hook in ~/.config/devin/config.json. Stop carries last_assistant_message
// and the prompt_id of the UserPromptSubmit it answers.
const SESSION_ID = "shared-jeep";
const PROMPT_ID = "47dd704e-3fb4-4817-915d-e04344144bc3";
const SESSION_START = { hook_event_name: "SessionStart", source: "startup", session_id: SESSION_ID };
const PROMPT = {
  hook_event_name: "UserPromptSubmit",
  prompt: "when is our deploy window",
  source: "user",
  session_id: SESSION_ID,
  prompt_id: PROMPT_ID,
};
const STOP = {
  hook_event_name: "Stop",
  stop_hook_active: false,
  last_assistant_message: "Thursday afternoons.",
  session_id: SESSION_ID,
  prompt_id: PROMPT_ID,
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Devin Local adapter", () => {
  test("keeps Devin Local events and maps Cascade ones to Stop", () => {
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      assert.equal(devinAdapter.mapEvent(event), event);
    }
    assert.equal(devinAdapter.mapEvent("post_cascade_response"), "Stop");
  });

  test("normalizes the captured Stop payload", async () => {
    const input = await devinAdapter.normalizeInput(STOP, "Stop");
    assert.equal(input.sessionId, SESSION_ID);
    assert.equal(input.turnId, PROMPT_ID);
    assert.equal(input.lastAssistantMessage, "Thursday afternoons.");
    assert.ok(Date.parse(input.timestamp));
  });

  test("returns context only for the two injecting events", () => {
    for (const event of ["SessionStart", "UserPromptSubmit"]) {
      assert.deepEqual(devinAdapter.formatOutput(event, { block: "<everme_recall>x</everme_recall>" }), {
        hookSpecificOutput: { hookEventName: event, additionalContext: "<everme_recall>x</everme_recall>" },
      });
    }
    assert.deepEqual(devinAdapter.formatOutput("Stop", { block: "x" }), {});
    assert.deepEqual(devinAdapter.formatOutput("UserPromptSubmit", { block: "" }), {});
  });
});

describe("Devin Local hook CLI", () => {
  test("UserPromptSubmit injects recall as additionalContext", async () => {
    const server = await startServer(async (req, res) => {
      await readBody(req);
      respond(res, 200, {
        status: 0,
        result: { items: [{ subject: "deploy window", episode: "Thursday afternoons" }], profiles: [] },
      });
    });
    const runtime = await runtimeEnv(server);

    const result = await runHookProcess("UserPromptSubmit", PROMPT, runtime.env);

    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(output.hookSpecificOutput.additionalContext, /everme_recall/);
    assert.match(output.hookSpecificOutput.additionalContext, /Thursday afternoons/);
  });

  test("SessionStart answers in the hookSpecificOutput shape or not at all", async () => {
    const server = await startServer(async (req, res) => {
      await readBody(req);
      respond(res, 200, { status: 0, result: { profiles: [], items: [] } });
    });
    const runtime = await runtimeEnv(server);

    const result = await runHookProcess("SessionStart", SESSION_START, runtime.env);

    assert.equal(result.code, 0, result.stderr);
    if (result.stdout) {
      assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, "SessionStart");
    }
  });

  test("Stop stores the prompt and the answer of the same prompt_id as one turn", async () => {
    const writes = [];
    const server = await startServer(async (req, res) => {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (req.url.endsWith("/mem/agent-memory")) writes.push(body);
      respond(res, 200, { status: 0, result: { items: [], profiles: [], flushed: false } });
    });
    const runtime = await runtimeEnv(server);
    const env = { ...runtime.env, EVERME_DEVIN_SYNC_INLINE: "1" };

    assert.equal((await runHookProcess("UserPromptSubmit", PROMPT, env)).code, 0);
    const stop = await runHookProcess("Stop", STOP, env);

    assert.equal(stop.code, 0, stop.stderr);
    assert.equal(stop.stdout, "");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].conversationId, SESSION_ID);
    assert.deepEqual(writes[0].messages.map(({ role, content }) => ({ role, content })), [
      { role: "user", content: "when is our deploy window" },
      { role: "assistant", content: "Thursday afternoons." },
    ]);
    for (const message of writes[0].messages) assert.ok(Number.isFinite(message.timestamp));
    assert.deepEqual(await readdir(runtime.stateDir).then((names) => names.filter((n) => n.startsWith("devin-prompt-"))), [],
      "the stashed prompt is consumed by its Stop");
  });

  test("a resent Stop of the same prompt_id is not stored twice", async () => {
    const writes = [];
    const server = await startServer(async (req, res) => {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (req.url.endsWith("/mem/agent-memory")) writes.push(body);
      respond(res, 200, { status: 0, result: { items: [], profiles: [], flushed: false } });
    });
    const runtime = await runtimeEnv(server);
    const env = { ...runtime.env, EVERME_DEVIN_SYNC_INLINE: "1" };

    await runHookProcess("UserPromptSubmit", PROMPT, env);
    await runHookProcess("Stop", STOP, env);
    await runHookProcess("Stop", STOP, env);

    assert.equal(writes.length, 1);
  });

  test("Stop returns at once and the detached worker uploads the turn", async () => {
    const writes = [];
    const server = await startServer(async (req, res) => {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (req.url.endsWith("/mem/agent-memory")) writes.push(body);
      respond(res, 200, { status: 0, result: { items: [], profiles: [], flushed: false } });
    });
    const runtime = await runtimeEnv(server);

    await runHookProcess("UserPromptSubmit", PROMPT, runtime.env);
    const stop = await runHookProcess("Stop", STOP, runtime.env);

    assert.equal(stop.code, 0, stop.stderr);
    assert.equal(stop.stdout, "");
    const deadline = Date.now() + 10_000;
    while (!writes.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(writes.length, 1, "the worker must upload the turn");
    assert.equal(writes[0].messages.at(-1).content, "Thursday afternoons.");
  });
});

describe("Stop payload handoff", () => {
  test("is owner-only, read once and confined to the state directory", async () => {
    const stateDir = await tempDir();
    const file = await writeStopPayload(STOP, { stateDir });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(await takeStopPayload(path.join(os.tmpdir(), "devin-stop-x.json"), { stateDir }), null);
    assert.deepEqual(await takeStopPayload(file, { stateDir }), STOP);
    assert.equal(await takeStopPayload(file, { stateDir }), null);
  });

  test("the worker hands the payload to the runtime as a Stop", async () => {
    const stateDir = await tempDir();
    const file = await writeStopPayload(STOP, { stateDir });
    const calls = [];
    await runWorker(file, { stateDir, runHook: async (...args) => { calls.push(args); } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "Stop");
    assert.deepEqual(calls[0][1], STOP);
    assert.deepEqual(calls[0][3], { detached: true });
  });
});

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "everme-devin-local-"));
  tempDirs.push(dir);
  return dir;
}

async function runtimeEnv(server) {
  const dir = await tempDir();
  const stateDir = path.join(dir, "state");
  const envFile = path.join(dir, "everme.env");
  await writeFile(envFile, [
    `EVERME_API_BASE=http://127.0.0.1:${server.address().port}`,
    "EVERME_AGENT_ID=agt_devin",
    "EVERME_AGENT_TOKEN=test-agent-token",
    `EVERME_STATE_DIR=${stateDir}`,
    "",
  ].join("\n"), { mode: 0o600 });
  return {
    stateDir,
    env: {
      ...process.env,
      EVERME_ENV_FILE_PATH: envFile,
      EVERME_AGENT_TOKEN: "",
      EVERME_AGENT_ID: "",
      EVERME_API_BASE: "",
      EVERME_STATE_DIR: "",
      EVERME_DEVIN_SYNC_INLINE: "",
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
