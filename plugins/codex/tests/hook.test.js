import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(packageDir, "tests", "fixtures", "codex-rollout.jsonl");
const tempDirs = [];
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("everme-codex hook CLI", () => {
  test("Stop writes the latest turn once and skips a duplicate turn id", async () => {
    const requests = [];
    const server = await startServer(async (req, res) => {
      requests.push({ path: req.url, body: JSON.parse(await readBody(req)) });
      respond(res, 200, {
        status: 0,
        result: { status: "accumulated", messageCount: 4, flushed: false },
      });
    });
    const runtime = await runtimeEnv(server);
    const input = {
      session_id: "codex-session",
      transcript_path: fixture,
      turn_id: "turn-latest",
      cwd: "/repo",
    };

    const first = await runHookProcess("Stop", input, runtime.env);
    const duplicate = await runHookProcess("Stop", input, runtime.env);

    assert.equal(first.code, 0);
    assert.equal(first.stdout, "");
    assert.equal(first.stderr, "");
    assert.equal(duplicate.code, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, "/api/v1/mem/agent-memory");
    assert.equal(requests[0].body.conversationId, "codex-session");
    assert.equal(requests[0].body.flush, false);
    assert.deepEqual(requests[0].body.messages.map((message) => message.role), [
      "user",
      "assistant",
      "tool",
      "assistant",
      "assistant",
      "assistant",
    ]);
    assert.equal(requests[0].body.messages[1].toolCalls[0].arguments, '{"path":"config.json"}');
  });

  test("backend failures are redacted and fail open", async () => {
    const token = "evt_cccccccccccccccccccccccccccccccc";
    const server = await startServer(async (_req, res) => {
      respond(res, 401, { status: 30101, error: `expired ${token}` });
    });
    const runtime = await runtimeEnv(server, token);

    const result = await runHookProcess("Stop", {
      session_id: "failed-session",
      transcript_path: fixture,
      turn_id: "failed-turn",
    }, runtime.env);

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, new RegExp(token));
    assert.match(result.stderr, /evt_cccc_REDACTED/);
    assert.equal(result.stderr.match(/\n/g)?.length, 1);
  });
});

async function runtimeEnv(server, token = "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "everme-codex-"));
  tempDirs.push(dir);
  const address = server.address();
  const envFile = path.join(dir, "everme.env");
  await writeFile(envFile, [
    `EVERME_API_BASE=http://127.0.0.1:${address.port}`,
    "EVERME_AGENT_ID=agt_codex",
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
