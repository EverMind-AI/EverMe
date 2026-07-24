import test from "node:test";
import assert from "node:assert/strict";
import { createHookRuntime, runHostHook } from "../src/hooks/runtime.js";

test("enqueueTurn never performs extraction and flush is an explicit boundary", async () => {
  const calls = [];
  const runtime = createHookRuntime({
    enqueue: async (turn) => calls.push(["enqueue", turn]),
    flush: async (conversationId) => calls.push(["flush", conversationId]),
  });

  await runtime.enqueueTurn({ conversationId: "s1", messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(calls, [["enqueue", { conversationId: "s1", messages: [{ role: "user", content: "hi" }], flush: false }]]);
  await runtime.onStop("s1");
  assert.deepEqual(calls, [["enqueue", { conversationId: "s1", messages: [{ role: "user", content: "hi" }], flush: false }], ["flush", "s1"]]);
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
