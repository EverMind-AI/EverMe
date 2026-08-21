import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { collectTurnMessages, installEverMeHooks } from "../index.js";

const usableConfig = {
  baseUrl: "https://example.invalid/api/v1",
  agentId: "agt_test",
  agentToken: "evt_00000000000000000000000000000000",
  injectTopK: 10,
  injectMinScore: 0,
  injectProfile: true,
};

function fakeContext() {
  const handlers = new Map();
  const warnings = [];
  return {
    handlers,
    warnings,
    logger: { info() {}, warn(line) { warnings.push(line); } },
    on(event, handler, options) {
      handlers.set(event, { handler, options });
    },
  };
}

function userMessage(text, id = "u1") {
  return { id, role: "user", content: [{ type: "text", text }], source: { kind: "user" } };
}


test("package declares a DSH bundle for native hook activation", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const patch = readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8");

  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
  assert.ok(manifest.files.includes("cordis.patch.yml"));
  assert.match(patch, /id: memory-everme-native/);
  assert.match(patch, /name: '@everme\/dsh'/);
});

test("pre-step appends query-specific recall on the first step", async () => {
  const ctx = fakeContext();
  const seen = [];
  installEverMeHooks(ctx, {}, {
    config: usableConfig,
    client: {},
    runInject: async (input) => {
      seen.push(input.input.prompt);
      return { block: "<everme_recall>remember this</everme_recall>", count: 1 };
    },
    createUserMessage: (message) => ({ ...message, id: "recall", role: "user" }),
  });

  const original = userMessage("what did we decide?");
  const result = await ctx.handlers.get("agent/pre-step").handler(
    { messages: [original], turn: 1, step: 1, signal: { aborted: false } },
    async () => ({ kind: "enter", messages: [original] }),
  );

  assert.deepEqual(seen, ["what did we decide?"]);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[1].source.plugin, "everme");
  assert.equal(result.messages[1].source.sections[0].name, "everme-recall");
  assert.deepEqual(ctx.handlers.get("agent/pre-step").options, { prepend: true });
});

test("pre-step degrades open and never duplicates recall on later steps", async () => {
  const ctx = fakeContext();
  let calls = 0;
  installEverMeHooks(ctx, {}, {
    config: usableConfig,
    client: {},
    runInject: async () => {
      calls += 1;
      throw new Error("evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa unavailable");
    },
  });
  const original = userMessage("hello");
  const handler = ctx.handlers.get("agent/pre-step").handler;
  const first = await handler(
    { messages: [original], turn: 1, step: 1, signal: { aborted: false } },
    async () => ({ kind: "enter", messages: [original] }),
  );
  const second = await handler(
    { messages: [], turn: 1, step: 2, signal: { aborted: false } },
    async () => ({ kind: "enter", messages: [] }),
  );

  assert.deepEqual(first.messages, [original]);
  assert.deepEqual(second.messages, []);
  assert.equal(calls, 1);
  assert.match(ctx.warnings[0], /REDACTED/);
  assert.doesNotMatch(ctx.warnings[0], /evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
});

test("turn-end saves one complete user-assistant-tool trajectory and flush waits", async () => {
  const ctx = fakeContext();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const saves = [];
  installEverMeHooks(ctx, {}, {
    config: usableConfig,
    client: {},
    saveAgentMemory: async (_client, request) => {
      saves.push(request);
      await blocked;
    },
  });

  const session = {
    id: "session-1",
    events: [
      { type: "turn/start", seq: 1, time: 1000, data: { turn: 1 } },
      { type: "user/message", seq: 2, time: 1010, data: userMessage("question") },
      { type: "user/message", seq: 3, time: 1020, data: { id: "p1", role: "user", content: [{ type: "text", text: "plugin context" }], source: { kind: "plugin", plugin: "other" } } },
      { type: "assistant/message", seq: 4, time: 1030, data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "checking" }, { type: "tool-call", id: "call-1", name: "read", arguments: "{\"path\":\"a\"}" }] } } },
      { type: "tool/result", seq: 5, time: 1040, data: { turn: 1, step: 1, message: { content: [{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "result" }] }] } } },
      { type: "assistant/message", seq: 6, time: 1050, data: { turn: 1, step: 2, message: { content: [{ type: "text", text: "answer" }] } } },
      { type: "turn/end", seq: 7, time: 1060, data: { turn: 1, reason: { kind: "completed" } } },
    ],
  };

  ctx.handlers.get("session/event").handler(session, session.events.at(-1));
  let flushed = false;
  const flushing = ctx.handlers.get("session/flush").handler(session).then(() => { flushed = true; });
  await Promise.resolve();
  assert.equal(flushed, false);
  release();
  await flushing;

  assert.equal(saves.length, 1);
  assert.equal(saves[0].conversationId, "session-1");
  assert.equal(saves[0].flush, true);
  assert.deepEqual(saves[0].messages.map((message) => message.role), ["user", "assistant", "tool", "assistant"]);
  assert.equal(saves[0].messages[1].content[1].type, "toolCall");
  assert.equal(saves[0].messages[2].toolCallId, "call-1");
});

test("collectTurnMessages returns only the requested turn", () => {
  const session = {
    events: [
      { type: "turn/start", seq: 1, time: 1, data: { turn: 1 } },
      { type: "user/message", seq: 2, time: 2, data: userMessage("first", "u1") },
      { type: "turn/end", seq: 3, time: 3, data: { turn: 1, reason: { kind: "completed" } } },
      { type: "turn/start", seq: 4, time: 4, data: { turn: 2 } },
      { type: "user/message", seq: 5, time: 5, data: userMessage("second", "u2") },
      { type: "turn/end", seq: 6, time: 6, data: { turn: 2, reason: { kind: "completed" } } },
    ],
  };

  assert.deepEqual(collectTurnMessages(session, 2, 6).map((message) => message.content), ["second"]);
});

test("missing credentials disable native hooks without throwing", () => {
  const ctx = fakeContext();
  const state = installEverMeHooks(ctx, {}, {
    config: { ...usableConfig, agentToken: "" },
  });

  assert.equal(state.enabled, false);
  assert.equal(ctx.handlers.size, 0);
  assert.match(ctx.warnings[0], /native hooks disabled/);
});
