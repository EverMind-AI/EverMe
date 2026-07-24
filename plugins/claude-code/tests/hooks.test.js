/**
 * Hook entry-point contract tests.
 *
 * Motivation: the OpenClaw factoryConfig regression (silent fallback to
 * legacy engine when host changed shape `{agentId, ...}` → `{config:
 * {agentId, ...}, ...}`) slipped through because tests only covered
 * `createContextEngine` directly, not the `register()` wiring. The
 * Claude Code hooks have the same shape of risk: each is a stdin-JSON
 * entry point whose input contract is owned by Claude Code, not us.
 * If CC renames `prompt` → `message.text` or `transcript_path` →
 * `transcript.path`, recall/save silently drop to no-op.
 *
 * These tests spawn each hook as a subprocess with a documented CC
 * stdin fixture, point it at a fake backend, and assert the backend
 * actually received the expected request shape. If CC's hook contract
 * ever changes, these tests fail loudly — that's the whole point.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_DIR = path.join(__dirname, "..", "hooks", "scripts");

/**
 * Spawn a hook as Claude Code would: node interpreter, stdin JSON
 * payload, env pointing at a fake backend. Resolves with full IO so
 * tests can introspect stdout/stderr/exit. 5s timeout (hooks should
 * complete in <1s against an in-process backend; longer = bug).
 */
function runHook(scriptName, stdinJson, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(HOOK_DIR, scriptName)], {
      env: { ...process.env, ...env, EVERME_ENV_FILE_PATH: "/tmp/__evercli_test_nonexistent.env" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`hook ${scriptName} timed out after 5s`));
    }, 5000);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    proc.on("error", reject);
    proc.stdin.end(stdinJson == null ? "" : JSON.stringify(stdinJson));
  });
}

/**
 * Minimal everme gateway: route table, captured-requests log so tests
 * can assert on what was POSTed. Mirrors openclaw/tests/engine.test.js
 * pattern — concrete request/response checks beat mock libraries here.
 *
 * IMPORTANT — wire envelope: the agent-sdk's HTTP client expects every
 * gateway response wrapped as `{status: 0, result: <data>}` for
 * success, or `{status: <nonzero>, error: <msg>}` for failure (see
 * plugins/agent-sdk/src/client.js::execOnce). Handlers return the
 * `result` payload directly; we wrap it here so tests don't have to
 * remember the envelope shape and can't accidentally fake "200 OK +
 * raw body" which the SDK actually rejects as upstream failure.
 */
function startBackend(handler) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = null;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw) {
        try { body = JSON.parse(raw); } catch { body = raw; }
      }
      calls.push({ method: req.method, path: req.url, body, headers: req.headers });
      const out = handler({ method: req.method, path: req.url, body }) || { status: 200, json: {} };
      const httpStatus = out.status || 200;
      res.writeHead(httpStatus, { "content-type": "application/json" });
      // Caller can opt out of envelope wrap (for testing non-JSON
      // bodies or upstream-failure paths) by setting `raw: true`.
      if (out.raw) {
        res.end(typeof out.body === "string" ? out.body : JSON.stringify(out.body ?? {}));
      } else if (httpStatus >= 200 && httpStatus < 300) {
        res.end(JSON.stringify({ status: 0, result: out.json ?? {} }));
      } else {
        res.end(JSON.stringify({ status: out.code || httpStatus, error: out.json?.error || "fake error" }));
      }
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      resolve({
        srv,
        calls,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

const FAKE_CREDS = {
  EVERME_AGENT_TOKEN: "evt_test_0123456789abcdef",
  EVERME_AGENT_ID: "agt_test_0123456789abcdef",
};

// -------------------------------------------------------------------- //
// inject-memories.js — UserPromptSubmit hook
// -------------------------------------------------------------------- //
describe("inject-memories.js: UserPromptSubmit hook contract", () => {
  let backend;
  before(async () => {
    backend = await startBackend(({ path: p }) => {
      if (p.endsWith("/mem/search")) {
        // SDK's searchMemory normalizes `res.items` → `out.memories`,
        // see plugins/agent-sdk/src/search.js. Mirror the real wire
        // shape; using `memories:` here would silently produce 0 hits
        // and mask the test.
        return {
          json: {
            items: [{ summary: "user prefers Go for backend", type: "episodic_memory", score: 0.9 }],
            profiles: [{ profileData: { embed_text: "hidden passive profile" } }],
            rawMessages: [],
            agentMemory: { cases: [], skills: [] },
          },
        };
      }
      return { status: 404, json: { error: "not found" } };
    });
  });
  after(() => backend.close());

  test("reads data.prompt from stdin and POSTs to /mem/search", async () => {
    // Documented CC payload shape: { prompt, transcript_path, cwd, ... }
    const ccPayload = {
      prompt: "/ask <everme_recall>old recall</everme_recall> What backend language do I prefer?",
      transcript_path: "/tmp/claude-transcripts/abc.jsonl",
      cwd: "/home/user/proj",
      session_id: "sess-1",
    };
    const { stdout, code, stderr } = await runHook("inject-memories.js", ccPayload, {
      ...FAKE_CREDS,
      EVERME_API_BASE: backend.url,
    });
    assert.equal(code, 0, `expected exit 0, stderr=${stderr}`);

    const searchCalls = backend.calls.filter((c) => c.path.endsWith("/mem/search"));
    assert.equal(searchCalls.length, 1, "exactly one /mem/search call");
    // CONTRACT: hook must extract `prompt` from CC's payload and pass it
    // as the query. If this fails, CC probably renamed the field — fix
    // the parser, don't just relax the assertion.
    assert.equal(
      searchCalls[0].body.query,
      "What backend language do I prefer?",
      "search query must be the user's prompt from stdin",
    );
    assert.equal(searchCalls[0].body.topK, 10, "shared hook default must request topK=10");

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(parsed.hookSpecificOutput.additionalContext, /everme_recall/);
    assert.doesNotMatch(parsed.hookSpecificOutput.additionalContext, /hidden passive profile/);
    assert.match(parsed.systemMessage, /Recalling 1 relevant memory/);
  });

  test("over-long prompt is truncated to the backend query limit", async () => {
    const before = backend.calls.length;
    // A huge paste (log dump / whole file) must not go to /mem/search
    // verbatim: the backend (BizMemory.Search) rejects query > 1024 runes
    // with ErrValidation, so an uncapped prompt would make recall fail.
    // The SDK's searchMemory clamps the query at 1024 chars (mirroring
    // MaxSearchQueryRunes); this is the end-to-end guard that the CC
    // recall path stays under that bound. Keep this fixture longer.
    const longPrompt = "word ".repeat(1000); // 5000 chars
    assert.ok(longPrompt.length > 1024, "fixture must exceed the cap");
    const { code, stderr } = await runHook(
      "inject-memories.js",
      { prompt: longPrompt, transcript_path: "/tmp/x.jsonl" },
      { ...FAKE_CREDS, EVERME_API_BASE: backend.url },
    );
    assert.equal(code, 0, `expected exit 0, stderr=${stderr}`);
    const searchCalls = backend.calls.slice(before).filter((c) => c.path.endsWith("/mem/search"));
    assert.equal(searchCalls.length, 1, "exactly one /mem/search call");
    assert.equal(searchCalls[0].body.query.length, 1024, "query capped at MAX_QUERY_CHARS");
    assert.ok(
      searchCalls[0].body.query.length <= 1024,
      "query must not exceed the backend's MaxSearchQueryRunes (1024)",
    );
    assert.equal(
      searchCalls[0].body.query,
      longPrompt.slice(0, 1024),
      "query must be the prompt's leading 1024 chars, not the whole paste",
    );
  });

  test("missing prompt → exit 0 silently, no backend call", async () => {
    const before = backend.calls.length;
    // Simulate the OpenClaw-style bug: CC ships a new schema and our
    // expected key is gone. We must NOT crash; we must NOT call the
    // backend with garbage query.
    const { code } = await runHook(
      "inject-memories.js",
      { message: { text: "future-CC-shape" }, transcript_path: "/x" },
      { ...FAKE_CREDS, EVERME_API_BASE: backend.url },
    );
    assert.equal(code, 0);
    const after = backend.calls.length;
    assert.equal(after, before, "no backend call when prompt is missing");
  });

  test("backend failure → exit 0 + visible WARN on stderr", async () => {
    const failing = await startBackend(() => ({ status: 500, json: { error: "fake outage" } }));
    try {
      const { code, stderr } = await runHook(
        "inject-memories.js",
        { prompt: "anything goes here too" },
        { ...FAKE_CREDS, EVERME_API_BASE: failing.url },
      );
      assert.equal(code, 0, "hook must never block on backend failure");
      // CONTRACT (silent-fail visibility): a degraded run prints one
      // WARN line so the user sees something is wrong without any
      // extra debug tooling. This guards the OpenClaw-style "looks
      // healthy but isn't" failure mode at the visibility layer.
      assert.match(stderr, /EverMe inject hook degraded:/, "stderr must surface degraded state");
    } finally {
      await failing.close();
    }
  });

  test("not configured (no token) → exit 0 silently, no backend call", async () => {
    const before = backend.calls.length;
    const { code } = await runHook(
      "inject-memories.js",
      { prompt: "anything" },
      { EVERME_API_BASE: backend.url /* no creds */ },
    );
    assert.equal(code, 0);
    assert.equal(backend.calls.length, before);
  });
});

// -------------------------------------------------------------------- //
// store-memories.js — Stop hook
// -------------------------------------------------------------------- //
describe("store-memories.js: Stop hook contract", () => {
  let backend;
  let tmpDir;
  before(async () => {
    backend = await startBackend(({ path: p }) => {
      if (p.endsWith("/mem/agent-memory")) {
        return { json: { status: "saved", flushed: true, messageCount: 2 } };
      }
      return { status: 404, json: { error: "not found" } };
    });
    tmpDir = mkdtempSync(path.join(tmpdir(), "everme-hook-test-"));
  });
  after(async () => {
    await backend.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeTranscript(content) {
    const p = path.join(tmpDir, `transcript-${Date.now()}-${Math.random()}.jsonl`);
    writeFileSync(p, content, { mode: 0o600 });
    return p;
  }

  test("reads transcript_path + session_id from stdin, POSTs to /mem/agent-memory", async () => {
    // Real Claude Code transcript schema: each line is nested
    //   { type:"user"|"assistant", message:{role, content}, ..., timestamp }
    // and a complete tool round-trip emits FOUR lines: user prompt,
    // assistant text+tool_use, user envelope carrying tool_result, and
    // assistant final reply. extractAgentMessages must produce a
    // matching 4-message trajectory (user/assistant w/ toolCalls /
    // tool w/ toolCallId / assistant) — anything less means we'd be
    // dropping the tool round-trip on the wire again.
    const transcriptPath = writeTranscript(
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "remember I like durian" },
          uuid: "e1b7a1a0-0000-4000-8000-000000000001",
          timestamp: "2026-05-15T08:00:00.000Z",
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Saving that now." },
              { type: "tool_use", id: "toolu_remember_1", name: "memory_write", input: { fact: "user_likes_durian" } },
            ],
          },
          uuid: "e1b7a1a0-0000-4000-8000-000000000002",
          timestamp: "2026-05-15T08:00:01.000Z",
        }),
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_remember_1", content: "fact stored" }],
          },
          uuid: "e1b7a1a0-0000-4000-8000-000000000003",
          timestamp: "2026-05-15T08:00:02.000Z",
        }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Noted." }] },
          uuid: "e1b7a1a0-0000-4000-8000-000000000004",
          timestamp: "2026-05-15T08:00:03.000Z",
        }),
        // turn_duration marker — readTranscript waits for it to
        // confirm the file is flushed before parsing.
        JSON.stringify({ type: "turn_duration", durationMs: 3000 }),
      ].join("\n"),
    );
    // Real documented Stop stdin: session_id / transcript_path / cwd /
    // hook_event_name / stop_hook_active — no turn_id field exists.
    const ccPayload = {
      transcript_path: transcriptPath,
      cwd: "/home/user/proj",
      session_id: "sess-fixture-1",
      hook_event_name: "Stop",
      stop_hook_active: false,
    };
    const { code, stderr } = await runHook("store-memories.js", ccPayload, {
      ...FAKE_CREDS,
      EVERME_API_BASE: backend.url,
      EVERME_STATE_DIR: path.join(tmpDir, "state-fixture"),
    });
    assert.equal(code, 0, `expected exit 0, stderr=${stderr}`);

    const saves = backend.calls.filter((c) => c.path.endsWith("/mem/agent-memory"));
    assert.equal(saves.length, 1, "exactly one /mem/agent-memory call");
    // CONTRACT: session_id from stdin must become conversationId on
    // the wire. If CC renames the field, this test fails.
    assert.equal(saves[0].body.conversationId, "sess-fixture-1");
    const msgs = saves[0].body.messages;
    assert.ok(Array.isArray(msgs), "messages must be an array");
    // The complete tool round-trip must reach the wire intact —
    // without this assertion the parser could silently drop tool_use
    // / tool_result and we'd be back to episodic-only extraction.
    const roles = msgs.map((m) => m.role);
    assert.deepEqual(
      roles,
      ["user", "assistant", "tool", "assistant"],
      "extractAgentMessages must surface the full user → assistant{tool_use} → tool{tool_result} → assistant cycle",
    );
    const assistantWithTool = msgs.find((m) => m.role === "assistant" && Array.isArray(m.toolCalls) && m.toolCalls.length);
    assert.ok(assistantWithTool, "assistant message must carry toolCalls[]");
    assert.equal(assistantWithTool.toolCalls[0].id, "toolu_remember_1");
    assert.equal(assistantWithTool.toolCalls[0].name, "memory_write");
    const toolMsg = msgs.find((m) => m.role === "tool");
    assert.equal(toolMsg.toolCallId, "toolu_remember_1", "tool message must reference the original tool_use id");
    assert.equal(saves[0].body.flush, false);
  });

  test("a re-fired Stop over an unchanged transcript is deduped via the derived turn key", async () => {
    // Claude Code sends no turn_id on Stop; dedup must work anyway, keyed
    // on the uuid of the transcript's last event. Same stdin + same
    // transcript twice → exactly one write.
    const transcriptPath = writeTranscript([
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "dedup me" },
        uuid: "d3d0b2c0-0000-4000-8000-00000000000a",
        timestamp: "2026-05-15T09:00:00.000Z",
      }),
      JSON.stringify({ type: "turn_duration", durationMs: 1000 }),
    ].join("\n"));
    const ccPayload = {
      transcript_path: transcriptPath,
      session_id: "sess-dedup",
      cwd: "/home/user/proj",
      hook_event_name: "Stop",
      stop_hook_active: false,
    };
    const env = {
      ...FAKE_CREDS,
      EVERME_API_BASE: backend.url,
      EVERME_STATE_DIR: path.join(tmpDir, "state-dedup"),
    };
    const before = backend.calls.length;

    const first = await runHook("store-memories.js", ccPayload, env);
    assert.equal(first.code, 0, first.stderr);
    const second = await runHook("store-memories.js", ccPayload, env);
    assert.equal(second.code, 0, second.stderr);

    const saves = backend.calls.slice(before).filter((call) => call.path.endsWith("/mem/agent-memory"));
    assert.equal(saves.length, 1, "second Stop over the same transcript must be deduped");
  });

  test("enqueues each turn and flushes extraction at turn five", async () => {
    const stateDir = path.join(tmpDir, "state-cadence");
    const transcriptPath = path.join(tmpDir, "transcript-cadence.jsonl");
    const before = backend.calls.length;
    const lines = [];
    for (let turn = 1; turn <= 5; turn++) {
      // Each turn appends new events (fresh uuid) like a real growing
      // transcript, so the derived turn key advances turn over turn.
      lines.push(JSON.stringify({
        type: "user",
        message: { role: "user", content: `cadence test turn ${turn}` },
        uuid: `cadence-uuid-${turn}`,
        timestamp: `2026-05-15T08:00:0${turn}.000Z`,
      }));
      lines.push(JSON.stringify({ type: "turn_duration", durationMs: 1000 }));
      writeFileSync(transcriptPath, lines.join("\n"), { mode: 0o600 });
      const { code, stderr } = await runHook("store-memories.js", {
        transcript_path: transcriptPath,
        session_id: "sess-cadence",
        hook_event_name: "Stop",
        stop_hook_active: false,
      }, {
        ...FAKE_CREDS,
        EVERME_API_BASE: backend.url,
        EVERME_STATE_DIR: stateDir,
      });
      assert.equal(code, 0, stderr);
    }

    const saves = backend.calls.slice(before).filter((call) => call.path.endsWith("/mem/agent-memory"));
    assert.deepEqual(saves.map((call) => call.body.flush), [false, false, false, false, false, true]);
  });

  test("missing transcript_path → exit 0, no backend call", async () => {
    const before = backend.calls.length;
    const { code } = await runHook(
      "store-memories.js",
      { /* CC schema drift: missing transcript_path */ cwd: "/x", session_id: "sess-x" },
      { ...FAKE_CREDS, EVERME_API_BASE: backend.url },
    );
    assert.equal(code, 0);
    assert.equal(backend.calls.length, before);
  });

  test("backend failure → exit 0 + visible WARN on stderr", async () => {
    const failing = await startBackend(() => ({ status: 500, json: { error: "fake outage" } }));
    try {
      const transcriptPath = writeTranscript(
        [
          JSON.stringify({
            type: "user",
            message: { role: "user", content: "test" },
            timestamp: "2026-05-15T08:00:00.000Z",
          }),
          JSON.stringify({ type: "turn_duration", durationMs: 1000 }),
        ].join("\n"),
      );
      const { code, stderr } = await runHook(
        "store-memories.js",
        { transcript_path: transcriptPath, session_id: "sess-fail" },
        { ...FAKE_CREDS, EVERME_API_BASE: failing.url },
      );
      assert.equal(code, 0, "Stop hook must never block on backend failure");
      assert.match(stderr, /EverMe store hook degraded:/, "stderr must surface degraded state");
    } finally {
      await failing.close();
    }
  });
});

// -------------------------------------------------------------------- //
// session-start.js — SessionStart hook
// -------------------------------------------------------------------- //
describe("session-start.js: SessionStart hook contract", () => {
  test("drains stdin and POSTs to /mem/context (no specific fields required)", async () => {
    const backend = await startBackend(({ path: p }) => {
      if (p.endsWith("/mem/context")) {
        // The shared renderProfileBlock reads `explicit_info[i].description`
        // / `.evidence`. Using the
        // wrong key here would produce empty stdout and silently mask
        // the test, the same failure mode this whole file exists to
        // surface.
        return {
          json: {
            profile: {
              explicit_info: [{ category: "food", description: "loves durian" }],
              implicit_traits: [],
            },
          },
        };
      }
      return { status: 404 };
    });
    try {
      const { stdout, code } = await runHook(
        "session-start.js",
        { cwd: "/home/user/proj", session_id: "sess-start-1" },
        { ...FAKE_CREDS, EVERME_API_BASE: backend.url },
      );
      assert.equal(code, 0);
      const ctxCalls = backend.calls.filter((c) => c.path.endsWith("/mem/context"));
      assert.equal(ctxCalls.length, 1);
      // stdout should be a UserPromptSubmit-style JSON with profile content
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
      assert.match(parsed.hookSpecificOutput.additionalContext, /durian/);
    } finally {
      await backend.close();
    }
  });

  test("empty profile → exit 0, empty stdout", async () => {
    const backend = await startBackend(({ path: p }) => {
      if (p.endsWith("/mem/context")) {
        return { json: { profile: { explicit_info: [], implicit_traits: [] } } };
      }
      return { status: 404 };
    });
    try {
      const { stdout, code } = await runHook(
        "session-start.js",
        { cwd: "/x", session_id: "s" },
        { ...FAKE_CREDS, EVERME_API_BASE: backend.url },
      );
      assert.equal(code, 0);
      assert.equal(stdout.trim(), "", "no stdout when profile is empty");
    } finally {
      await backend.close();
    }
  });

  test("not configured → exit 0, no backend call", async () => {
    const backend = await startBackend(() => ({ json: { profile: {} } }));
    try {
      const { code } = await runHook(
        "session-start.js",
        { cwd: "/x" },
        { EVERME_API_BASE: backend.url /* no creds */ },
      );
      assert.equal(code, 0);
      assert.equal(backend.calls.length, 0);
    } finally {
      await backend.close();
    }
  });
});

// -------------------------------------------------------------------- //
// session-summary.js — SessionEnd hook
// -------------------------------------------------------------------- //
describe("session-summary.js: SessionEnd hook contract", () => {
  test("flushes pending extraction without repeating messages", async () => {
    const backend = await startBackend(({ path: requestPath }) => {
      if (requestPath.endsWith("/mem/agent-memory")) return { json: { flushed: true } };
      return { status: 404 };
    });
    try {
      const { code } = await runHook(
        "session-summary.js",
        { transcript_path: "/x", session_id: "s", cwd: "/x" },
        { ...FAKE_CREDS, EVERME_API_BASE: backend.url },
      );
      assert.equal(code, 0);
      assert.equal(backend.calls.length, 1);
      assert.deepEqual(backend.calls[0].body, {
        conversationId: "s",
        messages: [],
        flush: true,
      });
    } finally {
      await backend.close();
    }
  });
});
