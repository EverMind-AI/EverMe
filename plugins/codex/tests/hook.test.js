import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codexAdapter } from "../src/adapter.js";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marketplaceDir = path.resolve(packageDir, "..", "everme");
const fixture = path.join(packageDir, "tests", "fixtures", "codex-rollout.jsonl");
const tempDirs = [];
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("everme-codex hook CLI", () => {
  test("native fragments sharing a session keep independent checkpoints and wire scopes", async () => {
    const writes = [];
    let supported = false;
    const server = await startServer(async (req, res) => {
      const body = JSON.parse(await readBody(req));
      if (req.url.endsWith("/agent-memory/state")) {
        respond(res, 200, { status: 0, result: { hookSyncScopeSupported: supported, sessions: [] } });
        return;
      }
      if (req.url.endsWith("/agent-memory")) writes.push(body);
      respond(res, 200, { status: 0, result: { status: "queued" } });
    });
    const runtime = await runtimeEnv(server);
    const root = "11111111-1111-1111-1111-111111111111";
    const fragments = ["22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333"];
    const dir = await mkdtemp(path.join(os.tmpdir(), "everme-fragments-"));
    tempDirs.push(dir);
    for (const [i, fragment] of fragments.entries()) {
      const transcript = path.join(dir, `rollout-2026-09-07T20-34-39-${root}_${fragment}.jsonl`);
      const events = [
        { type: "session_meta", payload: { id: root, history_mode: "paginated" } },
        { type: "response_item", timestamp: "2026-09-07T12:34:40Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `question ${i}` }] } },
        { type: "response_item", timestamp: "2026-09-07T12:34:41Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `answer ${i}` }] } },
      ];
      await writeFile(transcript, events.map(JSON.stringify).join("\n") + "\n");
      const input = { session_id: root, turn_id: `turn-${i}`, transcript_path: transcript };
      if (i === 0) {
        await runHookAt(marketplaceDir, "Stop", input, runtime.env);
        assert.equal(writes.length, 0);
        supported = true;
      }
      const result = await runHookAt(marketplaceDir, "Stop", input, runtime.env);
      assert.equal(result.code, 0, result.stderr);
      const repeat = await runHookAt(marketplaceDir, "Stop", input, runtime.env);
      assert.equal(repeat.code, 0, repeat.stderr);
    }
    assert.equal(writes.length, 2);
    assert.deepEqual(writes.map((row) => row.conversationId), [root, root]);
    assert.deepEqual(writes.map((row) => row.syncScope), fragments.map((id) => `codex-fragment-${id}`));
    assert.deepEqual(writes.map((row) => row.messages.length), [2, 2]);
    assert.deepEqual(writes.map((row) => row.baseTurn), [0, 0]);
  });
  test("marketplace bundle runs without workspace dependencies", async () => {
    const server = await startServer(async (_req, res) => {
      respond(res, 200, { status: 0, result: { flushed: true } });
    });
    const runtime = await runtimeEnv(server);
    const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "everme-codex-plugin-"));
    tempDirs.push(isolatedRoot);
    const isolatedPlugin = path.join(isolatedRoot, "everme");
    await cp(marketplaceDir, isolatedPlugin, { recursive: true });

    const manifest = JSON.parse(await readFile(path.join(isolatedPlugin, "hooks", "hooks.json"), "utf8"));
    const commands = Object.values(manifest.hooks)
      .flatMap((groups) => groups)
      .flatMap((group) => group.hooks)
      .map((hook) => hook.command);
    assert.deepEqual(commands, [
      'node "${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/bin/hook.mjs" hook SessionStart',
      'node "${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/bin/hook.mjs" hook UserPromptSubmit',
      'node "${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/bin/hook.mjs" hook Stop',
      'node "${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/bin/hook.mjs" hook PreCompact',
    ]);

    const result = await runHookAt(isolatedPlugin, "PreCompact", {
      session_id: "bundled-session",
      cwd: "/repo",
    }, runtime.env);

    assert.equal(result.code, 0);
    assert.match(result.stderr, /requestId=[0-9a-f-]{36}/,
      "stderr must carry the save line with its trace id");
  });

  // Codex runs a hook command through a shell with the SESSION cwd as the
  // working directory, not the plugin directory, and locates the plugin only
  // through PLUGIN_ROOT / CLAUDE_PLUGIN_ROOT. Exercise every manifest command
  // exactly that way: a cwd-relative runner path resolves against the user's
  // workspace and dies with MODULE_NOT_FOUND before the runner's fail-open
  // handler exists.
  test("manifest commands run from an unrelated session cwd", async () => {
    const server = await startServer(async (_req, res) => {
      respond(res, 200, { status: 0, result: { flushed: true } });
    });
    const runtime = await runtimeEnv(server);
    const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "everme-codex-cwd-"));
    tempDirs.push(isolatedRoot);
    const isolatedPlugin = path.join(isolatedRoot, "everme");
    await cp(marketplaceDir, isolatedPlugin, { recursive: true });
    const sessionCwd = path.join(isolatedRoot, "workspace");
    await mkdir(sessionCwd, { recursive: true });

    const manifest = JSON.parse(await readFile(path.join(isolatedPlugin, "hooks", "hooks.json"), "utf8"));
    const entries = Object.entries(manifest.hooks).map(([event, groups]) => ({
      event,
      command: groups.flatMap((group) => group.hooks).map((hook) => hook.command)[0],
    }));

    for (const { event, command } of entries) {
      for (const rootVar of ["PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"]) {
        const result = await runShellHook(command, sessionCwd, {
          ...runtime.env,
          [rootVar]: isolatedPlugin,
        }, { session_id: `cwd-${event}`, cwd: sessionCwd });
        assert.equal(result.code, 0, `${event} via ${rootVar}: ${result.stderr}`);
        assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND|Cannot find module/);
      }
    }
  });

  test("Stop writes the latest turn once and skips a duplicate turn id", async () => {
    const requests = [];
    const telemetry = [];
    const server = await startServer(async (req, res) => {
      const body = JSON.parse(await readBody(req));
      // Delivery telemetry shares the base URL; this test measures the
      // memory writes, so the reports are recorded apart from them.
      if (req.url.endsWith("/mem/import-events")) {
        telemetry.push(body);
        respond(res, 200, { status: 0, result: { ok: true } });
        return;
      }
      requests.push({ path: req.url, body });
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
    assert.match(
      first.stderr,
      /agent-memory stage=complete result=accepted .*requestId=[0-9a-f-]{36}/,
      "stderr must carry one bounded completion line with its trace id",
    );
    assert.equal(first.stderr.trim().split("\n").length, 2);
    assert.match(first.stderr, /codex parse lines=\d+ messages=\d+/);
    assert.equal(duplicate.code, 0);
    assert.equal(requests.length, 1);
    // A turn that lands reports nothing at all: the write the gateway just
    // took IS the record, so the hook stays at one request per turn.
    assert.deepEqual(telemetry, [], "the happy path must not add a second request");
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

  test("bundled Stop retains goal input, compresses oversized tasks and skips children", async () => {
    const requests = [];
    const server = await startServer(async (req, res) => {
      requests.push({ path: req.url, body: JSON.parse(await readBody(req)) });
      respond(res, 200, { status: 0, result: { flushed: false } });
    });
    const runtime = await runtimeEnv(server);
    const dir = await mkdtemp(path.join(os.tmpdir(), "everme-codex-task-"));
    tempDirs.push(dir);
    const rollout = path.join(dir, "root.jsonl");
    const item = (payload) => JSON.stringify({ type: "response_item", timestamp: "2026-09-07T00:00:00Z", payload });
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "root", history_mode: "paginated", thread_source: "user" } }),
      JSON.stringify({ type: "turn_context", payload: { turn_id: "goal-turn" } }),
      item({
        type: "message",
        role: "user",
        content: [
          "# AGENTS.md instructions\n\n<INSTRUCTIONS>unscoped system rules</INSTRUCTIONS>",
          "# AGENTS.md instructions for /repo\n<INSTRUCTIONS>scoped system rules</INSTRUCTIONS>",
          '<codex_internal_context source="goal">scheduler\nThe objective below is user-provided data.\n<objective>Verify deployment</objective>budget</codex_internal_context>',
        ].join("\n"),
      }),
      item({ type: "function_call", call_id: "native", name: "exec", arguments: "{}" }),
      item({ type: "function_call_output", call_id: "native", output: "Script completed\n" + "x".repeat(320000) + "\nexit code: 0" }),
      item({ type: "message", role: "assistant", content: "[external_agent_tool_call: exec]secret[/external_agent_tool_call]" }),
      item({ type: "message", role: "assistant", content: "[external_agent_tool_result]secret[/external_agent_tool_result]" }),
      item({ type: "message", role: "assistant", phase: "final_answer", content: "Verified" }),
    ].join("\n"));
    await writeFile(path.join(dir, "child.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "child", parent_thread_id: "root", thread_source: "subagent", history_mode: "paginated" } }),
      item({ type: "message", role: "user", content: "delegated input" }),
      item({ type: "message", role: "assistant", content: "child result" }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
    ].join("\n"));
    const input = { session_id: "root", turn_id: "goal-turn", transcript_path: rollout };
    const result = await runHookAt(marketplaceDir, "Stop", input, runtime.env);
    assert.equal(result.code, 0, result.stderr);
    const writes = requests.filter((request) => request.path === "/api/v1/mem/agent-memory");
    assert.equal(writes.length, 1);
    const body = writes[0].body;
    assert.equal(body.messages.length, 4);
    assert.equal(body.messages[0].content, "Verify deployment");
    assert.equal(body.messages[2].toolCallId, body.messages[1].toolCalls[0].id);
    assert.ok(Buffer.byteLength(body.messages[2].content) <= 4096);
    assert.match(body.messages[2].content, /exit code: 0$/);
    assert.equal(body.messages[3].content, "Verified");
    assert.doesNotMatch(JSON.stringify(body), /scheduler|budget|delegated|secret|system rules|taskBatching/);
    assert.match(result.stderr, /subagent_without_user=1/);
    assert.match(result.stderr, /dropped_legacy_tool_without_id=2/);
    const repeated = await runHookAt(marketplaceDir, "Stop", input, runtime.env);
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.equal(requests.filter((request) => request.path === "/api/v1/mem/agent-memory").length, 1);
  });

  test("bundled Stop preserves empty results and standalone search records", async () => {
    const requests = [];
    const server = await startServer(async (req, res) => {
      requests.push({ path: req.url, body: JSON.parse(await readBody(req)) });
      respond(res, 200, { status: 0, result: { flushed: false } });
    });
    const runtime = await runtimeEnv(server);
    const result = await runHookAt(marketplaceDir, "Stop", {
      session_id: "empty-tools-bundle",
      turn_id: "empty-tools-turn",
      transcript_path: path.join(packageDir, "tests", "fixtures", "codex-empty-tools-rollout.jsonl"),
    }, runtime.env);
    assert.equal(result.code, 0, result.stderr);
    const writes = requests.filter((request) => request.path === "/api/v1/mem/agent-memory");
    assert.equal(writes.length, 1, JSON.stringify(requests));
    const messages = writes[0].body.messages;
    assert.equal(messages.length, 9);
    const calls = messages.flatMap((message) => message.toolCalls || []);
    const results = messages.filter((message) => message.role === "tool");
    assert.equal(calls.length, 2);
    assert.equal(results.length, 2);
    assert.deepEqual(results.map((message) => message.toolCallId), calls.map((call) => call.id));
    assert.ok(results.every((message) => message.content === ""));
    assert.deepEqual(messages.slice(5, 8).map((message) => JSON.parse(message.content)), [
      { type: "web_search_call", status: "completed", action: { type: "search", query: "中文查询" } },
      { type: "web_search_call", status: "failed", action: { type: "open_page", url: "https://example.com/?token=[redacted]" } },
      { type: "web_search_call" },
    ]);
  });

  test("bundled Stop preserves assistant protocol quotations", async () => {
    const requests = [];
    const server = await startServer(async (req, res) => {
      requests.push({ path: req.url, body: JSON.parse(await readBody(req)) });
      respond(res, 200, { status: 0, result: { flushed: false } });
    });
    const runtime = await runtimeEnv(server);
    const dir = await mkdtemp(path.join(os.tmpdir(), "everme-codex-quotes-"));
    tempDirs.push(dir);
    const transcript = path.join(dir, "rollout.jsonl");
    const text = 'Example:\nSender (untrusted metadata):\n```json\n{"label":"example"}\n```\nLog: [message_id: native-id]\nstatus: failed\nEnd.';
    const rows = [
      { timestamp: "2026-09-06T10:00:00Z", type: "session_meta", payload: { id: "quoted-session", history_mode: "paginated", thread_source: "user" } },
      { timestamp: "2026-09-06T10:00:01Z", type: "response_item", payload: {
        type: "message", role: "user", content: [{ type: "input_text", text: "Explain this protocol." }],
      } },
      { timestamp: "2026-09-06T10:00:02Z", type: "response_item", payload: {
        type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text }],
      } },
    ];
    await writeFile(transcript, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const result = await runHookAt(marketplaceDir, "Stop", {
      session_id: "quoted-session", turn_id: "quoted-turn", transcript_path: transcript,
    }, runtime.env);
    assert.equal(result.code, 0, result.stderr);
    const writes = requests.filter(request => request.path === "/api/v1/mem/agent-memory");
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].body.messages.map(message => message.content), ["Explain this protocol.", text]);
  });

  test("Stop skips userless children and checkpoints the root once", async () => {
    const requests = [];
    const server = await startServer(async (req, res) => {
      requests.push({ path: req.url, body: JSON.parse(await readBody(req)) });
      respond(res, 200, {
        status: 0,
        result: { status: "accumulated", messageCount: 1, flushed: false },
      });
    });
    const runtime = await runtimeEnv(server);
    const rolloutDir = await mkdtemp(path.join(os.tmpdir(), "everme-codex-child-"));
    tempDirs.push(rolloutDir);
    const rootPath = path.join(rolloutDir, "root.jsonl");
    const childPath = path.join(rolloutDir, "child.jsonl");
    await writeFile(rootPath, [
      JSON.stringify({ type: "session_meta", payload: { id: "root", history_mode: "paginated", thread_source: "user" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "delegate this" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "root answer" }] } }),
    ].join("\n"));
    await writeFile(childPath, [
      JSON.stringify({ type: "session_meta", payload: { id: "child", history_mode: "paginated", thread_source: "subagent", parent_thread_id: "root" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "internal task wrapper" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "child-call", input: "pwd" } }),
      JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "child-call", output: "/repo" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "child answer" }] } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
    ].join("\n"));

    const input = {
      session_id: "root",
      transcript_path: rootPath,
      turn_id: "turn-with-child",
      cwd: "/repo",
    };
    const first = await runHookProcess("Stop", input, runtime.env);
    const laterStop = await runHookProcess("Stop", { ...input, turn_id: "later-stop" }, runtime.env);

    assert.equal(first.code, 0, first.stderr);
    assert.equal(laterStop.code, 0, laterStop.stderr);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests.map((request) => request.body.conversationId), ["root"]);
    assert.match(first.stderr, /subagent_without_user=1/);
    assert.doesNotMatch(JSON.stringify(requests), /child answer|internal task wrapper/);
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
    assert.equal(result.stderr.match(/\n/g)?.length, 2);
  });

  // Host-capability gate on the injected skill id (L2-2, L2-4).
  test("the marketplace bundle injects a redeemable skill id and never a case", async () => {
    const server = await startServer(async (req, res) => {
      if (req.url.endsWith("/mem/search")) {
        respond(res, 200, {
          status: 0,
          result: {
            items: [],
            profiles: [],
            rawMessages: [],
            agentMemory: {
              cases: [{ taskIntent: "Diagnose MCP not loading", approach: "Reinstall", keyInsight: "stale config" }],
              skills: [{ id: "sk_1", name: "N", description: "D", content: "BODY", relevanceScore: 0.99 }],
            },
          },
        });
        return;
      }
      respond(res, 200, { status: 0, result: {} });
    });
    const runtime = await runtimeEnv(server);
    const result = await runHookAt(marketplaceDir, "UserPromptSubmit", {
      session_id: "44444444-4444-4444-4444-444444444444",
      prompt: "help me run a security compliance review",
    }, runtime.env);

    assert.equal(result.code, 0, result.stderr);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.equal(codexAdapter.skillFetch, true, "the gate is driven by this declaration");
    assert.match(context, /\[skill sk_1\]/);
    assert.match(context, /mem_skill/);
    assert.doesNotMatch(context, /BODY/, "the body stays in the cache, never in the prompt");
    assert.doesNotMatch(context, /Past task cases/);
    assert.doesNotMatch(context, /Diagnose MCP not loading/);
  });

  test("the bundled MCP server advertises the resource the injected id is spent on", async () => {
    // The id is only redeemable because the same marketplace package ships
    // this server. Asserting both together is the point of the capability
    // bit: either the pair holds or the prompt is making a false promise.
    const templates = await mcpRequest(path.join(marketplaceDir, "bin", "memory-mcp.mjs"), {
      jsonrpc: "2.0", id: 2, method: "resources/templates/list", params: {},
    });
    const uris = (templates.result?.resourceTemplates || []).map((t) => t.uriTemplate);
    assert.ok(uris.some((uri) => uri.startsWith("mem://skill?id=")),
      `resources/templates/list must advertise mem://skill?id=; got ${uris.join(", ")}`);
  });
});

// Speaks one stdio JSON-RPC round trip to an MCP server bundle: initialize
// first (the server rejects anything else before it), then the real call.
function mcpRequest(serverPath, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        EVERME_AGENT_TOKEN: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        EVERME_AGENT_ID: "agt_codex",
        EVERME_API_BASE: "http://127.0.0.1:1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`MCP request ${request.method} timed out; stdout=${stdout}`));
    }, 10000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        if (frame.id !== request.id) continue;
        clearTimeout(timer);
        child.kill();
        resolve(frame);
      }
    });
    child.on("error", reject);
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    child.stdin.write(JSON.stringify(request) + "\n");
  });
}

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
  return runHookAt(packageDir, event, input, env, "bin/hook.js");
}

// Mirrors how Codex spawns a hook: the manifest command string is evaluated by
// a shell, from the session cwd, with the plugin root supplied via the
// environment.
function runShellHook(command, cwd, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

function runHookAt(cwd, event, input, env, runner = "bin/hook.mjs") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, "hook", event], {
      cwd,
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
