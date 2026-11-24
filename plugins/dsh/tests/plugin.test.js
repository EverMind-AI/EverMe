import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvermeError } from "@everme/agent-sdk";
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

test("writer skips userless children but retains root and human-started continuations", async () => {
  for (const child of [false, true]) {
    const ctx = fakeContext();
    const saves = [];
    installEverMeHooks(ctx, {}, { config: usableConfig, client: {}, saveAgentMemory: async (_client, request) => saves.push(request) });
    const session = nativeTurn([{ type: "tool-call", id: "native-call", name: "read", arguments: "{}" }]);
    if (child) {
      session.header = { origin: "subagent", parentSession: "parent" };
      session.events.unshift({ type: "subagent/descriptor", seq: -1, data: { version: 3, mode: "continuable", provider: "spawn" } });
    }
    const send = async () => {
      ctx.handlers.get("session/event").handler(session, session.events.at(-1));
      await ctx.handlers.get("session/flush").handler(session);
    };
    await send();
    assert.equal(saves.length, child ? 0 : 1);
    if (child) assert.ok(ctx.warnings.includes("[everme] conversion reason=subagent_without_user skipped=1"));
    let seq = 6;
    session.events.push(
      { type: "turn/start", seq: seq++, data: { turn: 2 } },
      { type: "user/message", seq: seq++, time: 1788681600010, data: { ...userMessage("continue", "human-followup"), source: { kind: "user", rpcId: "browser-request" } } },
      { type: "turn/end", seq: seq++, data: { turn: 2, reason: { kind: "completed" } } },
    );
    await send();
    assert.equal(saves.at(-1).messages[0].content, "continue");
    session.events.push(
      { type: "turn/start", seq: seq++, data: { turn: 3 } },
      { type: "assistant/message", seq: seq++, time: 1788681600020, data: { message: { content: [{ type: "text", text: "continued output" }] } } },
      { type: "turn/end", seq: seq++, data: { turn: 3, reason: { kind: "completed" } } },
    );
    await send();
    assert.equal(saves.length, child ? 2 : 3);
    assert.deepEqual(saves.at(-1).messages.map(message => message.content), [[{ type: "text", text: "continued output" }]]);
  }
});

test("native turn-end reaches HTTP with task-aware batching and final flush", async (t) => {
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: 0, result: { status: "accepted" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const ctx = fakeContext();
  installEverMeHooks(ctx, {}, { config: { ...usableConfig, baseUrl: `http://127.0.0.1:${server.address().port}/api/v1` } });
  const session = { id: "native-large-task", events: [] };
  const append = (type, data) => session.events.push({ type, seq: session.events.length, time: 1788681600000 + session.events.length, data });
  append("turn/start", { turn: 1 });
  append("user/message", userMessage("inspect files"));
  const original = "x".repeat(12000) + "\nlast line";
  for (let index = 0; index < 24; index++) {
    append("assistant/message", { turn: 1, step: index + 1, message: { content: [{ type: "tool-call", id: `native-${index}`, name: "read", arguments: "{}" }] } });
    append("tool/result", { turn: 1, step: index + 1, message: { content: [{ type: "tool-result", toolCallId: `native-${index}`, content: [{ type: "text", text: original }] }] } });
  }
  append("assistant/message", { turn: 1, step: 25, message: { content: [{ type: "text", text: "done" }] } });
  append("turn/end", { turn: 1, reason: { kind: "completed" } });
  ctx.handlers.get("session/event").handler(session, session.events.at(-1));
  await ctx.handlers.get("session/flush").handler(session);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].flush, true);
  const messages = bodies[0].messages;
  assert.equal(messages.length, 50);
  assert.equal(messages[0].content, "inspect files");
  assert.equal(messages.at(-1).content, "done");
  for (let index = 0; index < 24; index++) {
    assert.equal(messages[2 * index + 1].toolCalls[0].id, `native-${index}`);
    assert.equal(messages[2 * index + 2].toolCallId, `native-${index}`);
    assert.ok(Buffer.byteLength(messages[2 * index + 2].content) <= 4096);
    assert.ok(messages[2 * index + 2].content.endsWith("last line"));
  }
  const child = structuredClone(session);
  child.id = "native-child-task";
  child.header = { origin: "subagent", parentSession: session.id };
  child.events.unshift({ type: "subagent/descriptor", seq: -1, data: { version: 3, mode: "one-shot", provider: "spawn" } });
  ctx.handlers.get("session/event").handler(child, child.events.at(-1));
  await ctx.handlers.get("session/flush").handler(child);
  assert.equal(bodies.length, 1, "delegated child must not issue another HTTP request");
  assert.ok(ctx.warnings.includes("[everme] conversion reason=subagent_without_user skipped=1"));
});

test("trusted user text preserves quoted channel syntax without changing plugin filtering", () => {
  const quotes = [
    'Explain this example:\nSender (untrusted metadata):\n```json\n{"label":"example"}\n```\nKeep the quoted block.',
    'Inspect this log:\n[message_id: example-42]\nsender_id: example-user\nKeep the log lines.',
    '[Mon 2026-09-07 10:00 GMT+8] This timestamp is part of the user text.',
  ];
  for (const quote of quotes) {
    const session = {
      events: [
        { type: "turn/start", seq: 0, time: 1788746400000, data: { turn: 1 } },
        { type: "user/message", seq: 1, time: 1788746400001, data: { ...userMessage(quote), source: { kind: "plugin", plugin: "everme" } } },
        { type: "user/message", seq: 2, time: 1788746400002, data: userMessage(`  ${quote}  `) },
        { type: "turn/end", seq: 3, time: 1788746400003, data: { turn: 1, reason: { kind: "completed" } } },
      ],
    };
    assert.deepEqual(collectTurnMessages(session, 1, 3).map(message => message.content), [quote]);
  }
});

test("native child descriptors distinguish delegated tasks from browser-authored follow-ups", () => {
  for (const mode of ["one-shot", "continuable"]) {
    for (const provider of ["spawn", "renamed-fork"]) {
      const session = nativeTurn([{ type: "tool-call", id: "native-call", name: "read", arguments: "{}" }]);
      session.header = { origin: "subagent", parentSession: "parent-session" };
      const descriptor = { type: "subagent/descriptor", data: { version: 3, mode, provider, label: "Inspect a file" } };
      const task = { type: "user/message", data: userMessage("Inspect the delegated file") };
      session.events.splice(1, 0, descriptor, task);
      session.events.forEach((event, seq) => { event.seq = seq; });
      const warnings = [];
      const messages = collectTurnMessages(session, 1, session.events.at(-1).seq, { warn: line => warnings.push(line) });
      assert.deepEqual(messages.map(message => message.role), ["assistant", "tool", "assistant"]);
      assert.equal(messages[0].content[0].id, "native-call");
      assert.equal(messages[1].toolCallId, "native-call");
      assert.deepEqual(messages[1].content, []);
      assert.equal(messages.at(-1).turnComplete, true);
      assert.ok(warnings.includes("[everme] conversion reason=delegated_task dropped=1"));
      if (mode === "continuable") {
        const start = session.events.length;
        session.events.push(
          { type: "turn/start", seq: start, data: { turn: 2 } },
          { type: "user/message", seq: start + 1, data: { ...userMessage("Inspect the delegated file", "browser-message"), source: { kind: "user", rpcId: "browser-request" } } },
          { type: "turn/end", seq: start + 2, data: { turn: 2, reason: { kind: "completed" } } },
        );
        assert.deepEqual(collectTurnMessages(session, 2, start + 2).map(message => message.content), ["Inspect the delegated file"]);
      }
    }
  }
});

test("a child origin and a known descriptor are both required for task-source filtering", () => {
  const base = { events: [
    { type: "turn/start", seq: 0, data: { turn: 1 } },
    { type: "user/message", seq: 1, data: userMessage("Real user input") },
    { type: "turn/end", seq: 2, data: { turn: 1 } },
  ] };
  assert.equal(collectTurnMessages(base, 1, 2)[0].content, "Real user input");
  const originOnly = { ...base, header: { origin: "subagent" } };
  assert.equal(collectTurnMessages(originOnly, 1, 2)[0].content, "Real user input");
  const descriptorOnly = { events: [{ type: "subagent/descriptor", seq: -1, data: { version: 3, mode: "continuable", provider: "spawn", label: "Task" } }, ...base.events] };
  assert.equal(collectTurnMessages(descriptorOnly, 1, 2)[0].content, "Real user input");
});


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
  assert.equal(result.messages[1].source.kind, "everme");
  assert.equal(Object.hasOwn(result.messages[1].source, "plugin"), false);
  assert.equal(result.messages[1].source.form, "snapshot");
  assert.equal(result.messages[1].source.sections[0].name, "everme-recall");
  assert.deepEqual(ctx.handlers.get("agent/pre-step").options, { prepend: true });
});

test("installEverMeHooks attributes the real resolved config as hook/<dsh version>", async () => {
  // No dependencies.config override here — this exercises the real
  // resolveConfig(config) call inside installEverMeHooks, not a
  // pre-resolved stand-in, so a dropped clientKind/clientVersion wiring
  // on that call site would actually be caught.
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const ctx = fakeContext();
  const seenConfigs = [];
  installEverMeHooks(ctx, {
    apiBase: "https://example.invalid/api/v1",
    agentId: "agt_test",
    agentToken: "evt_00000000000000000000000000000000",
  }, {
    runInject: async (input) => {
      seenConfigs.push(input.config);
      return { block: "" };
    },
    createUserMessage: (message) => ({ ...message, id: "recall", role: "user" }),
  });

  const original = userMessage("what did we decide?");
  await ctx.handlers.get("agent/pre-step").handler(
    { messages: [original], turn: 1, step: 1, signal: { aborted: false } },
    async () => ({ kind: "enter", messages: [original] }),
  );

  assert.equal(seenConfigs.length, 1);
  assert.equal(seenConfigs[0].clientKind, "hook");
  assert.equal(seenConfigs[0].clientVersion, pkg.version);
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
  assert.equal(saves[0].taskBatching, true);
  assert.deepEqual(saves[0].messages.map((message) => message.role), ["user", "assistant", "tool", "assistant"]);
  assert.equal(saves[0].messages[1].content[1].type, "toolCall");
  assert.equal(saves[0].messages[2].toolCallId, "call-1");
});

function snapshotOnlySession(session) {
  const log = Object.freeze(session.events.map(event => Object.freeze(event)));
  return { id: session.id, header: session.header, snapshotEvents: () => log };
}

test("turn-end reads sessions that expose the log only through snapshotEvents", async () => {
  const ctx = fakeContext();
  const saves = [];
  installEverMeHooks(ctx, {}, { config: usableConfig, client: {}, saveAgentMemory: async (_client, request) => saves.push(request) });
  const native = nativeTurn([{ type: "text", text: "checking" }]);
  native.events.splice(1, 0,
    { type: "user/message", seq: 1.1, time: 1788681600000, data: userMessage("question") },
    { type: "user/message", seq: 1.2, time: 1788681600000, data: { ...userMessage("<everme_recall>old</everme_recall>", "recall"), source: { kind: "everme", form: "snapshot", sections: [] } } },
  );
  const session = snapshotOnlySession(native);
  ctx.handlers.get("session/event").handler(session, session.snapshotEvents().at(-1));
  await ctx.handlers.get("session/flush").handler(session);
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0].messages.map(message => message.role), ["user", "assistant", "tool", "assistant"]);
  assert.equal(saves[0].messages[0].content, "question");

  const child = nativeTurn([{ type: "text", text: "delegated" }]);
  child.header = { origin: "subagent", parentSession: "parent" };
  child.events.unshift({ type: "subagent/descriptor", seq: -1, data: { version: 3, mode: "one-shot", provider: "spawn" } });
  const childSession = snapshotOnlySession(child);
  ctx.handlers.get("session/event").handler(childSession, childSession.snapshotEvents().at(-1));
  await ctx.handlers.get("session/flush").handler(childSession);
  assert.equal(saves.length, 1);
  assert.ok(ctx.warnings.includes("[everme] conversion reason=subagent_without_user skipped=1"));
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

test("collectTurnMessages drops plugin context but preserves trusted agent activity", () => {
  const session = {
    events: [
      { type: "turn/start", seq: 1, time: 1, data: { turn: 1 } },
      { type: "user/message", seq: 2, time: 2, data: { role: "user", content: [{ type: "text", text: "injected recall" }], source: { kind: "plugin", plugin: "everme" } } },
      { type: "assistant/message", seq: 3, time: 3, data: { message: { content: [{ type: "text", text: "orphan answer" }] } } },
      { type: "tool/result", seq: 4, time: 4, data: { message: { content: [{ type: "tool-result", toolCallId: "orphan", content: [{ type: "text", text: "orphan result" }] }] } } },
      { type: "user/message", seq: 5, time: 5, data: userMessage("real question") },
      { type: "assistant/message", seq: 6, time: 6, data: { message: { content: [{ type: "text", text: "real answer" }] } } },
      { type: "turn/end", seq: 7, time: 7, data: { turn: 1 } },
    ],
  };

  const messages = collectTurnMessages(session, 1, 7);
  assert.deepEqual(messages.map((message) => message.role), ["assistant", "tool", "user", "assistant"]);
  assert.deepEqual(messages.map((message) => message.content), [
    [{ type: "text", text: "orphan answer" }],
    [{ type: "text", text: "orphan result" }],
    "real question",
    [{ type: "text", text: "real answer" }],
  ]);
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

function nativeTurn(blocks, result = [], reason = "completed") {
  return { id: "native-session", events: [
    { type: "turn/start", seq: 1, time: 1788681600000, data: { turn: 1 } },
    { type: "assistant/message", seq: 2, time: 1788681600001, data: { turn: 1, step: 1, message: { content: blocks } } },
    { type: "tool/result", seq: 3, time: 1788681600002, data: { turn: 1, step: 1, message: { content: [{ type: "tool-result", toolCallId: "native-call", content: result }] } } },
    { type: "assistant/message", seq: 4, time: 1788681600003, data: { turn: 1, step: 2, message: { content: [{ type: "text", text: "done" }] } } },
    { type: "turn/end", seq: 5, time: 1788681600004, data: { turn: 1, reason: { kind: reason } } },
  ] };
}

test("native malformed tools are rejected without changing valid adjacent text", () => {
  const tool = { type: "tool-call", id: "native-call", name: "unknown", arguments: "{}" };
  for (const [field, value] of [["id", undefined], ["id", 123], ["id", " "], ["name", undefined], ["arguments", undefined], ["arguments", "invalid JSON"]]) {
    const session = nativeTurn([{ type: "text", text: "progress" }, { ...tool, [field]: value }]);
    const warnings = [];
    const messages = collectTurnMessages(session, 1, 5, { warn: line => warnings.push(line) });
    assert.deepEqual(messages[0].content, [{ type: "text", text: "progress" }]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /dropped=[12]/);
  }
});

test("missing result content is distinct from an explicitly empty native result", () => {
  const session = nativeTurn([{ type: "tool-call", id: "native-call", name: "read", arguments: "{}" }]);
  assert.deepEqual(collectTurnMessages(session, 1, 5)[1].content, []);
  delete session.events[2].data.message.content[0].content;
  const warnings = [];
  assert.deepEqual(collectTurnMessages(session, 1, 5, { warn: line => warnings.push(line) }).map(message => message.role), ["assistant", "assistant"]);
  assert.match(warnings[0], /invalid_tool_result_content/);
});

test("invalid calls suppress only a uniquely correlated native result", () => {
  const invalid = { type: "tool-call", id: "native-call", arguments: "{}" };
  const unique = nativeTurn([invalid]);
  assert.equal(collectTurnMessages(unique, 1, 5).filter(message => message.role === "tool").length, 0);
  const duplicate = nativeTurn([invalid, { ...invalid, name: "read" }]);
  const messages = collectTurnMessages(duplicate, 1, 5);
  assert.equal(messages[0].content.length, 1);
  assert.equal(messages.filter(message => message.role === "tool").length, 1);
  assert.equal(messages[1].toolCallId, "native-call");
});

test("only a completed turn's real final assistant text is a completion boundary", () => {
  const session = nativeTurn([{ type: "text", text: "progress" }, { type: "tool-call", id: "native-call", name: "read", arguments: "{}" }]);
  assert.deepEqual(collectTurnMessages(session, 1, 5).filter(message => message.role === "assistant").map(message => message.turnComplete), [false, true]);
  session.events.at(-1).data.reason.kind = "max-tokens";
  assert.deepEqual(collectTurnMessages(session, 1, 5).filter(message => message.role === "assistant").map(message => message.turnComplete), [false, false]);
  session.events.at(-1).data.reason.kind = "completed";
  session.events[3].data.message.content = [{ type: "reasoning", text: "internal" }];
  assert.equal(collectTurnMessages(session, 1, 5)[0].turnComplete, false);
});

test("the native event hook refuses missing session identity", async () => {
  const ctx = fakeContext();
  const saves = [];
  installEverMeHooks(ctx, {}, { config: usableConfig, client: {}, saveAgentMemory: async (_client, request) => saves.push(request) });
  const session = nativeTurn([{ type: "text", text: "answer" }]);
  delete session.id;
  ctx.handlers.get("session/event").handler(session, session.events.at(-1));
  await ctx.handlers.get("session/flush").handler(session);
  assert.equal(saves.length, 0);
  assert.match(ctx.warnings[0], /invalid_session_id/);
});

test("conversion diagnostics never include source content or unbounded event labels", () => {
  const session = nativeTurn([{ type: "text", text: "answer" }]);
  session.events[2].data.message.content[0].toolCallId = " ";
  session.events.splice(2, 0, { type: "extension/" + "x".repeat(2000), seq: 2, data: { text: "private body" } });
  const warnings = [];
  collectTurnMessages(session, 1, 5, { warn: line => warnings.push(line) });
  assert.ok(warnings.some(line => /invalid_tool_result_id/.test(line)));
  assert.ok(warnings.some(line => /non_dialogue_event/.test(line)));
  assert.ok(warnings.every(line => line.length < 100 && !line.includes("private body") && !line.includes("extension/")));
});

function deliveryHome(t) {
  const saved = process.env.EVERME_MEMORY_HOME;
  const home = mkdtempSync(join(tmpdir(), "everme-dsh-delivery-"));
  process.env.EVERME_MEMORY_HOME = home;
  t.after(() => {
    process.env.EVERME_MEMORY_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });
  const dir = join(home, "delivery");
  return {
    files: () => (existsSync(dir) ? readdirSync(dir).sort() : []),
    read: kind => JSON.parse(readFileSync(join(dir, `dsh.${kind}.json`), "utf8")),
  };
}

async function deliverTurn(session, saveAgentMemory, event = session.events?.at(-1)) {
  const ctx = fakeContext();
  installEverMeHooks(ctx, {}, { config: { ...usableConfig, agentId: "agt_0123456789abcdef" }, client: {}, saveAgentMemory });
  ctx.handlers.get("session/event").handler(session, event);
  await ctx.handlers.get("session/flush").handler(session);
  return ctx;
}

test("an unreadable session records a skip and never reaches the writer", async (t) => {
  const delivery = deliveryHome(t);
  let saves = 0;
  await deliverTurn({ id: "no-events" }, async () => { saves += 1; }, { type: "turn/end", seq: 5, data: { turn: 1 } });
  assert.equal(saves, 0);
  assert.deepEqual(delivery.files(), ["dsh.skip.json"]);
  const body = delivery.read("skip");
  assert.equal(body.schema, 1);
  assert.equal(body.reason, "session_unreadable");
  assert.equal(body.agent_ref, "a58b8fb7581c597a");
  assert.equal(body.plugin_version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  assert.match(body.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("a missing turn start and a fully filtered turn leave no delivery record", async (t) => {
  const delivery = deliveryHome(t);
  const noStart = nativeTurn([{ type: "text", text: "answer" }]);
  noStart.events.shift();
  const filtered = { id: "filtered", events: [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: { ...userMessage("plugin context"), source: { kind: "plugin", plugin: "other" } } },
    { type: "turn/end", seq: 3, data: { turn: 1, reason: { kind: "completed" } } },
  ] };
  let saves = 0;
  for (const session of [noStart, filtered]) await deliverTurn(session, async () => { saves += 1; });
  assert.equal(saves, 0);
  assert.deepEqual(delivery.files(), []);
});

test("an upload that was sent records ok and a null result records nothing", async (t) => {
  const delivery = deliveryHome(t);
  await deliverTurn(nativeTurn([{ type: "text", text: "answer" }]), async () => null);
  assert.deepEqual(delivery.files(), []);
  await deliverTurn(nativeTurn([{ type: "text", text: "answer" }]), async () => ({ status: "accepted" }));
  assert.deepEqual(delivery.files(), ["dsh.ok.json"]);
  const body = delivery.read("ok");
  assert.equal(body.reason, null);
  assert.equal(body.agent_ref, "a58b8fb7581c597a");
  assert.match(body.at, /Z$/);
});

test("a failed upload records the mapped reason and still reaches the save log", async (t) => {
  const cases = [
    [new EvermeError({ message: "denied", status: 401, type: "auth" }), "auth"],
    [new EvermeError({ message: "slow", type: "timeout" }), "timeout"],
    [new EvermeError({ message: "missing", status: 404 }), "http_4xx"],
    [new EvermeError({ message: "down", status: 503 }), "http_5xx"],
    [new EvermeError({ message: "refused", status: 0 }), "network"],
    [new Error("boom"), "other"],
  ];
  for (const [error, reason] of cases) {
    const delivery = deliveryHome(t);
    const ctx = await deliverTurn(nativeTurn([{ type: "text", text: "answer" }]), async () => { throw error; });
    assert.deepEqual(delivery.files(), ["dsh.fail.json"]);
    assert.equal(delivery.read("fail").reason, reason);
    assert.equal(delivery.read("fail").agent_ref, "a58b8fb7581c597a");
    assert.ok(ctx.warnings.includes(`[everme] save degraded open: ${error.message}`));
  }
});
