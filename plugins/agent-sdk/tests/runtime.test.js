import test from "node:test";
import assert from "node:assert/strict";
import { createHookRuntime, runHostHook } from "../src/hooks/runtime.js";
import { saveAgentMemory, flushAgentMemory } from "../src/agent-memory.js";
import { createSessionState } from "../src/hooks/state.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("hook enqueue waits for synchronous persistence before a boundary flush", async () => {
  const events = [];
  let finishAdd;
  const persistence = new Promise((resolve) => { finishAdd = resolve; });
  const client = {
    async request(_method, _path, body) {
      if (body.messages.length) {
        assert.equal(body.sync, true);
        assert.equal(body.flush, false);
        events.push("add-start");
        await persistence;
        events.push("add-persisted");
      } else {
        assert.deepEqual(events, ["add-start", "add-persisted", "checkpoint"]);
        events.push("flush");
      }
      return { status: "accepted" };
    },
  };
  const runtime = createHookRuntime({
    enqueue: (turn) => saveAgentMemory(client, turn),
    flush: (conversationId) => flushAgentMemory(client, { conversationId }),
    rethrowOnError: true,
  });
  const upload = runtime.enqueueTurn({ conversationId: "s", messages: [{ role: "user", content: "hello" }] });
  // The fallback timestamp is resolved before the request leaves.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["add-start"]);
  finishAdd();
  await upload;
  events.push("checkpoint");
  await runtime.flush("s");
  assert.deepEqual(events, ["add-start", "add-persisted", "checkpoint", "flush"]);
});

test("enqueueTurn never performs extraction and flush is an explicit boundary", async () => {
  const calls = [];
  const runtime = createHookRuntime({
    enqueue: async (turn) => calls.push(["enqueue", turn]),
    flush: async (conversationId) => calls.push(["flush", conversationId]),
  });

  await runtime.enqueueTurn({ conversationId: "s1", messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(calls, [["enqueue", { conversationId: "s1", messages: [{ role: "user", content: "hi" }], flush: false, sync: true }]]);
  await runtime.onStop("s1");
  assert.deepEqual(calls, [["enqueue", { conversationId: "s1", messages: [{ role: "user", content: "hi" }], flush: false, sync: true }], ["flush", "s1"]]);
  await runtime.onSessionEnd("s1");
  assert.equal(calls.at(-1)[0], "flush");
});

test("host failures are non-blocking and are reported through diagnostics", async () => {
  const diagnostics = [];
  const runtime = createHookRuntime({
    enqueue: async () => { throw new Error(`token=evt_${"a".repeat(32)}`); },
    flush: async () => { throw new Error("flush failed"); },
    diagnostic: (message) => diagnostics.push(message),
  });
  await assert.doesNotReject(runtime.enqueueTurn({ conversationId: "s1", messages: [] }));
  await assert.doesNotReject(runtime.onSessionEnd("s1"));
  assert.equal(diagnostics.length, 2);
  assert.ok(diagnostics.every((line) => !line.includes(`evt_${"a".repeat(32)}`)));
});

test("missing adapter formatter remains fail-open", async () => {
  const stderr = [];
  const output = await runHostHook("SessionStart", {}, {
    normalizeInput: async () => ({}),
  }, {
    env: { EVERME_AGENT_TOKEN: "emk_test" },
    resolveConfig: () => ({ isConfigured: false }),
    writeStderr: (line) => stderr.push(line),
  });
  assert.deepEqual(output, {});
  assert.deepEqual(stderr, []);
});

test("runHostHook dispatches lifecycle events through the SDK runtime", async () => {
  const calls = [];
  const adapter = {
    envFile: () => undefined,
    normalizeInput: async (raw) => raw,
    formatOutput: (event, result) => ({ event, ...result }),
  };
  const config = { isConfigured: true, authMode: "evt", agentId: "agt_test" };

  const output = await runHostHook("Stop", { sessionId: "s1", turnId: "t1" }, adapter, {
    baseEnv: {},
    config,
    client: { id: "client" },
    createTurnCounter: () => ({ increment: async () => ({ count: 1, duplicate: false }) }),
    runStore: async (args) => {
      calls.push(["store", args.input.sessionId, args.client.id, args.config.agentId]);
      return { block: "", count: 1 };
    },
    redactError: (error) => String(error?.message || error),
  });

  assert.deepEqual(calls, [["store", "s1", "client", "agt_test"]]);
  assert.deepEqual(output, { event: "Stop", block: "", count: 1 });
});

test("runHostHook maps SessionEnd and PreCompact to boundary flush", async () => {
  const flushed = [];
  const adapter = {
    normalizeInput: (raw) => raw,
    formatOutput: (event, result) => ({ event, ...result }),
  };

  for (const event of ["SessionEnd", "PreCompact"]) {
    await runHostHook(event, { sessionId: "s1" }, adapter, {
      config: { isConfigured: true, authMode: "evt", agentId: "agt_test" },
      client: {},
      runBoundaryFlush: async ({ input }) => {
        flushed.push(input.sessionId);
        return { block: "", count: 0, flushed: true };
      },
    });
  }

  assert.deepEqual(flushed, ["s1", "s1"]);
});

test("runHostHook stores at SessionEnd a session no Stop stored, when the adapter asks", async () => {
  const adapter = {
    normalizeInput: (raw) => raw,
    formatOutput: (event, result) => ({ event, ...result }),
    storeAtSessionEndWithoutStop: true,
  };
  const run = async (count) => {
    const calls = [];
    await runHostHook("SessionEnd", { sessionId: "s1", turnId: "g1" }, adapter, {
      config: { isConfigured: true, authMode: "evt", agentId: "agt_test" },
      client: {},
      sessionState: { read: async () => ({ count }), patch: async () => ({}) },
      counter: { peek: async () => ({ count: 1, duplicate: false }), commit: async () => ({ count: 1 }) },
      runStore: async ({ input }) => {
        calls.push(["store", input.turnId]);
        return { block: "", count: 1 };
      },
      runBoundaryFlush: async () => {
        calls.push(["flush"]);
        return { block: "", count: 0, flushed: true };
      },
    });
    return calls;
  };

  assert.deepEqual(await run(0), [["store", "g1"], ["flush"]], "headless run: no Stop fired, so SessionEnd stores the turn, then ends the session");
  assert.deepEqual(await run(2), [["flush"]], "Stop already stored this session's turns");
});

test("a one-shot session stores the turn of every run at SessionEnd, until a Stop stores one", async () => {
  // cursor-agent -p --continue: each run fires SessionEnd and never Stop, so
  // each run's SessionEnd is the only chance to store that run's turn.
  const dir = await mkdtemp(path.join(os.tmpdir(), "everme-oneshot-"));
  try {
    const sessionState = createSessionState({ stateDir: dir });
    const adapter = {
      normalizeInput: (raw) => raw,
      formatOutput: (event, result) => ({ event, ...result }),
      storeAtSessionEndWithoutStop: true,
    };
    const calls = [];
    const run = (event) => runHostHook(event, { sessionId: "s1", turnId: "" }, adapter, {
      config: { isConfigured: true, authMode: "evt", agentId: "agt_test" },
      client: {},
      sessionState,
      counter: { peek: async () => ({ count: 1, duplicate: false }), commit: async () => ({ count: 1 }) },
      runStore: async () => {
        calls.push(`${event}:store`);
        return { block: "", count: 2 };
      },
      runBoundaryFlush: async () => {
        calls.push(`${event}:flush`);
        return { block: "", count: 0, flushed: true };
      },
    });

    await run("SessionEnd");
    // The store commits the turn, as runStore does, before the next run.
    await sessionState.patch("s1", { count: 1 });
    await run("SessionEnd");
    assert.deepEqual(calls, ["SessionEnd:store", "SessionEnd:flush", "SessionEnd:store", "SessionEnd:flush"]);

    calls.length = 0;
    await run("Stop");
    await run("SessionEnd");
    assert.deepEqual(calls, ["Stop:store", "SessionEnd:flush"], "a Stop stored a turn, so SessionEnd only ends the session");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runHostHook keeps the boundary flush at SessionEnd for adapters that do not ask", async () => {
  const calls = [];
  await runHostHook("SessionEnd", { sessionId: "s1" }, { normalizeInput: (raw) => raw }, {
    config: { isConfigured: true, authMode: "evt", agentId: "agt_test" },
    client: {},
    sessionState: { read: async () => ({ count: 0 }), patch: async () => ({}) },
    runStore: async () => {
      calls.push("store");
      return { block: "", count: 1 };
    },
    runBoundaryFlush: async () => {
      calls.push("flush");
      return { block: "", count: 0, flushed: true };
    },
  });
  assert.deepEqual(calls, ["flush"]);
});

test("runHostHook fails open and redacts diagnostics when an operation fails", async () => {
  let stderr = "";
  const adapter = {
    normalizeInput: (raw) => raw,
    formatOutput: (event, result) => ({ event, ...result }),
  };

  const output = await runHostHook("SessionStart", {}, adapter, {
    config: { isConfigured: true, authMode: "emk", agentId: "" },
    client: {},
    runSessionStart: async () => {
      throw new Error("backend rejected evt_secret\nprivate detail");
    },
    redactError: (error) => String(error?.message || error).replace("evt_secret", "evt_[REDACTED]"),
    writeStderr: (line) => { stderr += line; },
  });

  assert.deepEqual(output, { event: "SessionStart", block: "", count: 0, degraded: true });
  assert.match(stderr, /evt_\[REDACTED\]/);
  assert.doesNotMatch(stderr, /\n.*private detail/);
  assert.equal(stderr.match(/\n/g)?.length, 1);
});

test("Stop hands runStore a ledger in the hook state dir and keeps the host write timeout", async () => {
  const adapter = {
    envFile: () => undefined,
    normalizeInput: async (raw) => raw,
    formatOutput: (event, result) => ({ event, ...result }),
  };
  const config = { isConfigured: true, authMode: "evt", agentId: "agt_test" };
  const seen = [];
  let store;
  await runHostHook("Stop", { sessionId: "s1", turnId: "t1" }, adapter, {
    env: { EVERME_STATE_DIR: "/tmp/everme-hook-state" },
    config,
    client: { id: "client" },
    createTurnCounter: () => ({}),
    createTimestampLedger: (options) => {
      seen.push(options);
      return { id: "ledger" };
    },
    runStore: async (args) => {
      store = args;
      return { block: "", count: 1 };
    },
    redactError: (error) => String(error?.message || error),
  });
  assert.deepEqual(seen, [{ stateDir: "/tmp/everme-hook-state" }]);
  assert.deepEqual(store.timestampLedger, { id: "ledger" });
  assert.equal(store.writeTimeoutMs, undefined);
  assert.ok(store.config.deadlineAt - Date.now() <= 27_000);
});

test("a detached worker waits out a slow write instead of the host's hook budget", async () => {
  const adapter = {
    envFile: () => undefined,
    normalizeInput: async (raw) => raw,
    formatOutput: (event, result) => ({ event, ...result }),
  };
  const config = { isConfigured: true, authMode: "evt", agentId: "agt_test" };
  let store;
  const started = Date.now();
  await runHostHook("Stop", { sessionId: "s1", turnId: "t1" }, adapter, {
    env: {},
    config,
    client: { id: "client" },
    createTurnCounter: () => ({}),
    detached: true,
    runStore: async (args) => {
      store = args;
      return { block: "", count: 1 };
    },
    redactError: (error) => String(error?.message || error),
  });
  assert.equal(store.writeTimeoutMs, 120_000);
  assert.ok(store.config.deadlineAt - started >= 179_000);
});


// The degraded line is the status the host shows: it names the brand.
test("runHostHook names the EverOS brand in its degraded line", async () => {
  let stderr = "";
  await runHostHook("SessionStart", {}, { normalizeInput: (raw) => raw, formatOutput: (event, result) => ({ event, ...result }) }, {
    baseEnv: { EVERME_BRAND: "everos" },
    config: { isConfigured: true, authMode: "emk", agentId: "" },
    client: {},
    runSessionStart: async () => { throw new Error("gateway down"); },
    writeStderr: (line) => { stderr += line; },
  });
  assert.match(stderr, /^EverOS start hook degraded/);
});

test("a brand env file owns every key it sets; an EverMe file keeps process overrides", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(path.join(tmpdir(), "everme-envfile-"));
  const seen = async (fileBody) => {
    const file = path.join(dir, "brand.env");
    writeFileSync(file, fileBody);
    let env;
    await runHostHook("SessionStart", {}, { envFile: () => file, normalizeInput: (raw) => raw }, {
      baseEnv: { EVERME_API_BASE: "https://exported.example", EVERME_STATE_DIR: "/exported/state", EVERME_MEMORY_HOME: "/exported/memory" },
      resolveConfig: (e) => {
        env = e;
        return { isConfigured: false };
      },
    });
    return env;
  };
  const saved = process.env.EVERME_STATE_DIR;
  try {
    const everos = await seen("EVERME_API_BASE=http://127.0.0.1:47391\nEVERME_AGENT_TOKEN=t\nEVERME_BRAND=everos\nEVERME_MEMORY_HOME=/everos/memory\nEVERME_STATE_DIR=/everos/state\n");
    assert.equal(everos.EVERME_API_BASE, "http://127.0.0.1:47391");
    assert.equal(everos.EVERME_STATE_DIR, "/everos/state");
    assert.equal(everos.EVERME_MEMORY_HOME, "/everos/memory");
    assert.equal(process.env.EVERME_STATE_DIR, "/everos/state", "caches that read process.env follow the brand");

    const everme = await seen("EVERME_API_BASE=https://api.everme.evermind.ai\nEVERME_AGENT_TOKEN=t\n");
    assert.equal(everme.EVERME_API_BASE, "https://exported.example", "the EverMe dev override still wins");
  } finally {
    if (saved === undefined) delete process.env.EVERME_STATE_DIR;
    else process.env.EVERME_STATE_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
