import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { createContextEngine } from "../src/engine.js";
import { resolveConfig } from "@everme/agent-sdk";

const pluginMeta = { id: "@everme/openclaw", name: "EverMe", version: "0.1.0" };

/**
 * Minimal everme-shaped backend that responds to /mem/context and
 * /mem/uploads/presign + /mem/sources (so flush works).
 */
function startBackend({ contextResult, searchResult, failAgentMemory = false } = {}) {
  let failing = failAgentMemory;
  let dropping = false;
  let delayMs = 0;
  let presignCalls = 0;
  let sourceCalls = 0;
  let agentMemoryCalls = 0;
  let lastAgentMemory = null;
  const agentMemoryBodies = [];
  let searchCalls = 0;
  let lastSearch = null;
  let lastHeaders = null;

  const srv = http.createServer((req, res) => {
    lastHeaders = req.headers;
    let chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const path = url.pathname;

      if (path === "/healthz") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
        return;
      }
      if (path === "/api/v1/mem/search") {
        searchCalls++;
        lastSearch = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "ok",
          status: 0,
          requestId: "r",
          result: searchResult || {
            items: [{ id: "ep1", subject: "prior fact", episode: "prior fact about the user", atomicFacts: ["prior fact about the user"], relevanceScore: 0.5, timestamp: "2026-05-11T10:00:00Z" }],
            profiles: [],
          },
        }));
        return;
      }
      if (path === "/api/v1/mem/context") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "ok",
            status: 0,
            requestId: "r",
            result: contextResult || { context: "## memory\n- prior fact", memoryCount: 1 },
          }),
        );
        return;
      }
      if (path === "/api/v1/mem/agent-memory") {
        agentMemoryCalls++;
        lastAgentMemory = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        agentMemoryBodies.push(lastAgentMemory);
        // The connection drops after the request arrived: the client cannot
        // tell whether the write landed.
        if (dropping) {
          req.socket.destroy();
          return;
        }
        if (failing) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "upstream down", status: 50101, requestId: "r" }));
          return;
        }
        const body = JSON.stringify({
          error: "ok",
          status: 0,
          result: { status: "accumulated", messageCount: lastAgentMemory.messages?.length || 0, flushed: true },
        });
        setTimeout(() => res.writeHead(200, { "Content-Type": "application/json" }).end(body), delayMs);
        return;
      }
      if (path === "/api/v1/mem/uploads/presign") {
        presignCalls++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "ok",
            status: 0,
            result: {
              objectKey: "objects/x",
              uploadUrl: `http://127.0.0.1:${srv.address().port}/s3`,
              formFields: { key: "objects/x" },
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          }),
        );
        return;
      }
      if (path === "/api/v1/mem/sources") {
        sourceCalls++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "ok", status: 0, result: { id: "src_x" } }));
        return;
      }
      if (path === "/s3") {
        res.writeHead(204).end();
        return;
      }
      res.writeHead(404).end();
    });
  });

  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      resolve({
        baseUrl: `http://127.0.0.1:${srv.address().port}`,
        getPresignCalls: () => presignCalls,
        getSourceCalls: () => sourceCalls,
        getAgentMemoryCalls: () => agentMemoryCalls,
        getLastAgentMemory: () => lastAgentMemory,
        getAgentMemoryBodies: () => agentMemoryBodies,
        getSearchCalls: () => searchCalls,
        getLastSearch: () => lastSearch,
        getLastHeaders: () => lastHeaders,
        setFailAgentMemory: (value) => { failing = value; },
        setDropAgentMemory: (value) => { dropping = value; },
        setAgentMemoryDelay: (value) => { delayMs = value; },
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

function mkEngine(baseUrl, overrides = {}) {
  return createContextEngine(
    pluginMeta,
    {
      apiBase: baseUrl,
      agentId: "agt_x",
      agentToken: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      flushMaxBytes: 1024 * 1024,
      ...overrides,
    },
    { info() {}, warn() {} },
  );
}

describe("engine", () => {
  test("afterTurn compresses only oversized complete read tasks", async (t) => {
    const backend = await startBackend();
    t.after(() => backend.close());
    for (const count of [1, 8]) {
      const original = "x".repeat(40000) + "\nlast line";
      const timestamp = 1788652800123;
      const messages = [{ role: "user", content: "inspect files", timestamp }];
      for (let index = 0; index < count; index++) {
        messages.push({ role: "assistant", timestamp, stopReason: "toolUse", content: [{ type: "toolCall", id: `native-${index}`, name: "read", arguments: { path: `file-${index}` } }] });
        messages.push({ role: "toolResult", timestamp, toolCallId: `native-${index}`, content: [{ type: "text", text: original }] });
      }
      messages.push({ role: "assistant", timestamp, stopReason: "stop", content: [{ type: "text", text: "done" }] });
      await mkEngine(backend.baseUrl).afterTurn({ sessionKey: `read-${count}`, messages, prePromptMessageCount: 0 });
      const sent = backend.getLastAgentMemory().messages;
      assert.equal(sent.length, count * 2 + 2);
      assert.equal(sent[0].content, "inspect files");
      assert.equal(sent.at(-1).content, "done");
      for (let index = 0; index < count; index++) {
        assert.equal(sent[index * 2 + 1].toolCalls[0].id, `native-${index}`);
        assert.equal(sent[index * 2 + 2].toolCallId, `native-${index}`);
        if (count === 1) assert.equal(sent[index * 2 + 2].content, original);
        else assert.ok(Buffer.byteLength(sent[index * 2 + 2].content) <= 4096);
        assert.ok(sent[index * 2 + 2].content.endsWith("last line"));
        assert.equal(messages[index * 2 + 2].content[0].text, original);
      }
    }
  });

  test("afterTurn preserves the native assistant stop state", async (t) => {
    const backend = await startBackend();
    t.after(() => backend.close());
    for (const stopReason of ["stop", "length", "toolUse", "error", "aborted"]) {
      const engine = mkEngine(backend.baseUrl);
      const messages = [{
        role: "assistant", content: stopReason === "toolUse"
          ? [{ type: "toolCall", id: "native-call", name: "read", arguments: { path: "file.txt" } }]
          : [{ type: "text", text: "Visible response." }],
        stopReason, timestamp: 1788652800123,
      }];
      await engine.afterTurn({ sessionKey: `native-${stopReason}`, messages, prePromptMessageCount: 0 });
      assert.equal(backend.getLastAgentMemory().messages[0].turnComplete, stopReason === "stop");
    }
  });

  test("afterTurn rejects invalid native tool contracts without inventing names or arguments", async (t) => {
    const backend = await startBackend();
    t.after(() => backend.close());
    for (const [patch, reason] of [
      [{ name: undefined }, "invalid_tool_name"],
      [{ name: "  " }, "invalid_tool_name"],
      [{ name: 42 }, "invalid_tool_name"],
      [{ arguments: "command: pwd" }, "invalid_tool_arguments"],
    ]) {
      const warnings = [];
      const engine = createContextEngine(pluginMeta, {
        apiBase: backend.baseUrl, agentId: "agt_x",
        agentToken: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", flushEveryTurns: 5,
      }, { info() {}, warn(message) { warnings.push(message); } });
      const messages = nativeToolTurn([
        { type: "text", text: "Reading both files." },
        { type: "toolCall", id: "bad-call", name: "read", arguments: {}, ...patch },
        { type: "toolCall", id: "good-call", name: "unknown", arguments: { path: "file.txt" } },
      ], ["bad-call", "good-call"]);
      const original = structuredClone(messages);
      await engine.afterTurn({ sessionKey: "native-session", prePromptMessageCount: 0, messages });
      const sent = backend.getLastAgentMemory().messages;
      assert.deepEqual(sent.map(message => message.role), ["user", "assistant", "tool", "assistant"]);
      assert.equal(sent[1].content, "Reading both files.");
      assert.deepEqual(sent[1].toolCalls, [{ id: "good-call", type: "function", name: "unknown", arguments: '{"path":"file.txt"}' }]);
      assert.equal(sent[2].toolCallId, "good-call");
      assert.deepEqual(messages, original);
      assert.deepEqual(warnings, [`[everme] openclaw parse reason=${reason} dropped_calls=1 dropped_results=1`]);
    }
  });

  test("afterTurn preserves valid argument encodings and does not guess duplicate ID ownership", async (t) => {
    const backend = await startBackend();
    t.after(() => backend.close());
    const messages = nativeToolTurn([
      { type: "toolCall", id: "shared-id", arguments: {} },
      { type: "toolCall", id: "shared-id", name: "read", arguments: '{"path":"file.txt"}' },
      { type: "toolCall", id: "no-args", name: "unknown" },
    ], ["no-args", "shared-id"]);
    await mkEngine(backend.baseUrl).afterTurn({ sessionKey: "native-session", prePromptMessageCount: 0, messages });
    const sent = backend.getLastAgentMemory().messages;
    assert.deepEqual(sent[1].toolCalls, [
      { id: "shared-id", type: "function", name: "read", arguments: '{"path":"file.txt"}' },
      { id: "no-args", type: "function", name: "unknown", arguments: "{}" },
    ]);
    assert.deepEqual(sent.filter(message => message.role === "tool").map(message => message.toolCallId), ["no-args", "shared-id"]);
  });

  test("afterTurn drops invalid native tool IDs without inventing associations", async (t) => {
    const backend = await startBackend();
    t.after(() => backend.close());
    for (const role of ["assistant", "toolResult"]) {
      for (const id of [undefined, "  ", 42]) {
        const warnings = [];
        const engine = createContextEngine(pluginMeta, {
          apiBase: backend.baseUrl,
          agentId: "agt_x",
          agentToken: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          flushEveryTurns: 5,
        }, { info() {}, warn(message) { warnings.push(message); } });
        // Required native IDs are deliberately corrupted to test the source-error policy.
        const messages = [
          { role: "user", timestamp: 1787306400000, content: "Check the file." },
          { role: "assistant", timestamp: 1787306401000, content: [
            { type: "toolCall", id: role === "assistant" ? id : "call-native", name: "read", arguments: { path: "file.txt" } },
          ] },
          { role: "toolResult", timestamp: 1787306402000, toolCallId: role === "toolResult" ? id : "call-native", content: [{ type: "text", text: "Private result body" }] },
          { role: "assistant", timestamp: 1787306403000, content: [{ type: "text", text: "Done." }] },
        ];
        const original = structuredClone(messages);
        await engine.afterTurn({ sessionKey: "native-session", prePromptMessageCount: 0, messages });
        const sent = backend.getLastAgentMemory().messages;
        assert.deepEqual(sent.map(message => message.role), role === "assistant"
          ? ["user", "tool", "assistant"] : ["user", "assistant", "assistant"]);
        if (role === "assistant") assert.equal(sent[1].toolCallId, "call-native");
        else assert.equal(sent[1].toolCalls[0].id, "call-native");
        assert.deepEqual(messages, original, "the source must not be mutated");
        assert.deepEqual(warnings, [
          `[everme] openclaw parse dropped_invalid_call_id=${role === "assistant" ? 1 : 0} dropped_invalid_result_id=${role === "toolResult" ? 1 : 0}`,
        ]);
      }
    }
  });

  test("afterTurn preserves native tool IDs literally and keeps parallel result order", async (t) => {
    const backend = await startBackend();
    t.after(() => backend.close());
    const messages = [
      { role: "user", timestamp: 1787306400000, content: "Read both files." },
      { role: "assistant", timestamp: 1787306401000, content: [
        { type: "toolCall", id: " call-left ", name: "read", arguments: { path: "left" } },
        { type: "toolCall", id: "call-right", name: "read", arguments: { path: "right" } },
      ] },
      { role: "toolResult", timestamp: 1787306402000, toolCallId: "call-right", content: [] },
      { role: "toolResult", timestamp: 1787306403000, toolCallId: " call-left ", content: [{ type: "text", text: "left content" }] },
      { role: "assistant", timestamp: 1787306404000, content: [{ type: "text", text: "Done." }] },
    ];
    await mkEngine(backend.baseUrl).afterTurn({ sessionKey: "native-session", prePromptMessageCount: 0, messages });
    const sent = backend.getLastAgentMemory().messages;
    assert.deepEqual(sent[1].toolCalls.map(call => call.id), [" call-left ", "call-right"]);
    assert.deepEqual(sent.filter(message => message.role === "tool").map(message => message.toolCallId), ["call-right", " call-left "]);
    assert.equal(sent[2].content, "");
  });

  test("bootstrap returns bootstrapped:true without hitting the backend", async (t) => {
    const s = await startBackend();
    t.after(async () => s.close());
    let backendHits = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      backendHits++;
      return origFetch(...args);
    };
    t.after(() => { globalThis.fetch = origFetch; });

    const eng = mkEngine(s.baseUrl);
    const res = await eng.bootstrap({ sessionKey: "sess" });
    assert.deepEqual(res, { bootstrapped: true });
    assert.equal(backendHits, 0, "bootstrap must not make any backend HTTP calls");
  });

  test("assemble pulls all sections from /mem/search and renders them as systemPromptAddition", async (t) => {
    const s = await startBackend({
      searchResult: {
        items: [{ id: "ep1", subject: "golden retriever", episode: "user mentioned having a golden retriever named Wangcai", atomicFacts: ["user has a golden retriever named Wangcai"], relevanceScore: 0.6, timestamp: "2026-05-11T10:00:00Z" }],
        profiles: [{ id: "p1", profileData: { item_type: "explicit_info", embed_text: "宠物: 用户养了一只名叫旺财的金毛犬" }, relevanceScore: 0.5 }],
        rawMessages: [{ id: "r1", senderName: "alice", contentItems: [{ type: "text", text: "顺便记一下我要去京都看樱花" }], timestamp: "2026-05-11T11:00:00Z" }],
        agentMemory: { skills: [{ id: "s1", name: "双文件协同记忆更新", description: "long-term memory + daily log sync" }] },
      },
    });
    t.after(async () => s.close());
    const eng = mkEngine(s.baseUrl);
    const r = await eng.assemble({ sessionKey: "sess", messages: [], prompt: "tell me what you know about me" });
    // assemble should NOT consult /mem/context now that /mem/search
    // covers profile + episodes + raw_messages + agent_memory in one
    // call. Verify by counting the search hits.
    assert.equal(s.getSearchCalls(), 1, "assemble must call /mem/search exactly once");
    // All four section headers must render together.
    assert.match(r.systemPromptAddition, /Episodic memory/);
    assert.match(r.systemPromptAddition, /User profile/);
    assert.match(r.systemPromptAddition, /Recent unextracted transcript/);
    // No Agent skills: this host cannot fetch a body, so the section is
    // withheld rather than injected as an unredeemable summary.
    assert.doesNotMatch(r.systemPromptAddition, /Agent skills/);
    // And the per-row content survives the renderer.
    assert.match(r.systemPromptAddition, /Wangcai/);
    assert.match(r.systemPromptAddition, /旺财/);
    assert.match(r.systemPromptAddition, /京都看樱花/);
    assert.ok(r.estimatedTokens > 0);
    // The default body should expand memoryTypes to all four — the
    // gateway default — by leaving the field unset here. (Plugin
    // doesn't narrow today; if it ever does, this is the boundary
    // test that flags the change.)
    assert.equal(s.getLastSearch().memoryTypes, undefined);
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(s.getLastHeaders()["x-everme-client"], `hook/${pkg.version}`);
  });

  // Reverse validation of the host-capability gate (L2-3, L2-4). OpenClaw
  // declares no skillFetch and passes no option, so the default must hold.
  // A skill row it cannot redeem is worse than no row at all, so the whole
  // section is withheld — not merely stripped of its id.
  test("assemble renders no skill section and no case section at all", async (t) => {
    const s = await startBackend({
      searchResult: {
        items: [],
        profiles: [],
        rawMessages: [],
        agentMemory: {
          cases: [{ taskIntent: "Diagnose MCP not loading", approach: "Reinstall", keyInsight: "stale config" }],
          skills: [{ id: "sk_1", name: "N", description: "D", content: "BODY", relevanceScore: 0.99 }],
        },
      },
    });
    t.after(async () => s.close());
    const eng = mkEngine(s.baseUrl);
    const r = await eng.assemble({ sessionKey: "sess", messages: [], prompt: "help me run a security compliance review" });
    // Skills and cases were the only rows in this response, so nothing is
    // left to inject and assemble must not fabricate an empty block.
    assert.equal(r.systemPromptAddition, undefined);
    assert.equal(r.estimatedTokens, 0);
  });

  test("assemble uses the recall knobs, not the MCP-channel cfg.topK", async (t) => {
    // assemble is per-turn auto-injection, so it must request injectTopK
    // rows and apply injectMinScore — the same shape the UserPromptSubmit
    // hook uses. It used to send cfg.topK with no floor at all.
    const s = await startBackend({
      searchResult: {
        items: [
          { id: "keep", episode: "user prefers Vitest for unit tests", relevanceScore: 0.55 },
          { id: "drop", episode: "unrelated low-ranked row", relevanceScore: 0.12 },
        ],
      },
    });
    t.after(async () => s.close());
    const eng = mkEngine(s.baseUrl);
    const r = await eng.assemble({ sessionKey: "sess", messages: [], prompt: "which test runner do I use" });
    // Not tautological: cfg.topK (the MCP-channel default) and injectTopK
    // resolve to different numbers, so this pins which one reached the wire.
    const knobs = resolveConfig({});
    assert.notEqual(knobs.injectTopK, knobs.topK, "fixture is meaningless if the two defaults ever converge");
    assert.equal(s.getLastSearch().topK, knobs.injectTopK, "must request injectTopK, not cfg.topK");
    assert.match(r.systemPromptAddition, /Vitest/);
    assert.doesNotMatch(r.systemPromptAddition, /unrelated low-ranked row/, "below-floor episodes must be dropped");
  });

  test("assemble injects nothing when every episode is below the floor", async (t) => {
    const s = await startBackend({
      searchResult: { items: [{ id: "low", episode: "way below the floor", relevanceScore: 0.05 }] },
    });
    t.after(async () => s.close());
    const eng = mkEngine(s.baseUrl);
    const r = await eng.assemble({ sessionKey: "sess", messages: [], prompt: "do I like tomatoes" });
    assert.equal(r.systemPromptAddition, undefined, "no fallback floor — an all-below-threshold turn injects nothing");
    assert.equal(r.estimatedTokens, 0);
  });

  test("assemble skips on /clear", async (t) => {
    const s = await startBackend();
    t.after(async () => s.close());
    const eng = mkEngine(s.baseUrl);
    const r = await eng.assemble({ sessionKey: "sess", messages: [], prompt: "/clear" });
    assert.equal(r.systemPromptAddition, undefined);
    assert.equal(r.estimatedTokens, 0);
  });

  test("compacted snapshots use the native turn boundary without positional watermarks", async (t) => {
    const s = await startBackend();
    t.after(async () => s.close());
    const eng = mkEngine(s.baseUrl);
    const text = (role, content, timestamp) => ({ role, content, timestamp });
    await eng.afterTurn({ sessionKey: "compact", prePromptMessageCount: 2, messages: [
      text("user", "old task", 1000), text("assistant", "old answer", 2000),
      text("user", "second task", 3000), text("assistant", "second answer", 4000),
    ] });
    await eng.compact({ sessionKey: "compact" });
    // A compacted context can equal the previous cursor length or be shorter.
    for (const prefixLength of [2, 1]) {
      await eng.afterTurn({ sessionKey: "compact", prePromptMessageCount: prefixLength, messages: [
        ...Array.from({ length: prefixLength }, () => text("assistant", "retained context", 4000)),
        text("user", `new task ${prefixLength}`, 9000 - prefixLength * 2000),
        text("assistant", `new answer ${prefixLength}`, 10000 - prefixLength * 2000),
      ] });
    }
    const writes = s.getAgentMemoryBodies().filter(body => body.messages.length);
    assert.equal(writes.length, 3);
    assert.deepEqual(writes.map(body => body.messages.map(message => message.content)), [
      ["second task", "second answer"], ["new task 2", "new answer 2"], ["new task 1", "new answer 1"],
    ]);
    assert.ok(writes.every(body => !Object.hasOwn(body, "baseTurn")));
    assert.ok(writes.every(body => body.conversationId === "compact" && body.channel === "hook"));
    // The first afterTurn met a snapshot with history before its tail
    // (prePromptMessageCount: 2): a cold start that claims nothing. The
    // compacted turns after it are the process's own and claim one turn each.
    assert.deepEqual(writes.map(body => body.turns), [0, 1, 1]);
  });

  test("a snapshot that is the first turn is addressed at turn 0, later turns append", async (t) => {
    const s = await startBackend();
    t.after(async () => s.close());
    const eng = mkEngine(s.baseUrl);
    const text = (role, content, timestamp) => ({ role, content, timestamp });
    const allMessages = [text("user", "first task", 1000), text("assistant", "first answer", 2000)];
    await eng.afterTurn({ sessionKey: "fresh", prePromptMessageCount: 0, messages: allMessages });
    allMessages.push(text("user", "second task", 3000), text("assistant", "second answer", 4000));
    await eng.afterTurn({ sessionKey: "fresh", prePromptMessageCount: 2, messages: allMessages });
    const writes = s.getAgentMemoryBodies().filter(body => body.messages.length);
    assert.equal(writes.length, 2);
    // The whole snapshot was the tail: the session provably starts here, so
    // the write carries baseTurn 0 and anchors the ledger row.
    assert.equal(writes[0].baseTurn, 0);
    assert.equal(writes[0].turns, 1);
    // The next turn is unaddressed (snapshots compact) and claims one turn.
    assert.ok(!Object.hasOwn(writes[1], "baseTurn"));
    assert.equal(writes[1].turns, 1);
    // So the gate never trims them by time.
    assert.ok(writes.every(body => body.channel === "hook" && body.deduplication === "client-native-id"));
  });

  test("a first afterTurn on a session with history is a cold start that claims nothing", async (t) => {
    const s = await startBackend();
    t.after(async () => s.close());
    const eng = mkEngine(s.baseUrl);
    const text = (role, content, timestamp) => ({ role, content, timestamp });
    // The gateway restarted on a session that already had turns; the plugin
    // first sees it at its third turn.
    const allMessages = [
      text("user", "old task", 1000), text("assistant", "old answer", 2000),
      text("user", "older task", 3000), text("assistant", "older answer", 4000),
      text("user", "new task", 5000), text("assistant", "new answer", 6000),
    ];
    await eng.afterTurn({ sessionKey: "joined", prePromptMessageCount: 4, messages: allMessages });
    allMessages.push(text("user", "next task", 7000), text("assistant", "next answer", 8000));
    await eng.afterTurn({ sessionKey: "joined", prePromptMessageCount: 6, messages: allMessages });
    const writes = s.getAgentMemoryBodies().filter(body => body.messages.length);
    assert.deepEqual(writes.map(body => body.messages.map(message => message.content)), [
      ["new task", "new answer"], ["next task", "next answer"],
    ]);
    assert.ok(writes.every(body => !Object.hasOwn(body, "baseTurn")));
    assert.deepEqual(writes.map(body => body.turns), [0, 1]);
  });

  test("afterTurn writes through realtime agent memory", async (t) => {
    const s = await startBackend();
    t.after(async () => s.close());
    const eng = mkEngine(s.baseUrl, { flushEveryTurns: 2 });
    await eng.afterTurn({
      sessionKey: "sess",
      messages: [
        { role: "user", timestamp: 1710000000000, content: "weather?" },
        { role: "assistant", timestamp: 1710000001000, content: [{ type: "text", text: "Let me check" }, { type: "toolCall", id: "call_a", name: "get_weather", arguments: { city: "Tokyo" } }] },
        { role: "toolResult", timestamp: 1710000002000, toolCallId: "call_a", content: [{ type: "text", text: "18C" }] },
      ],
    });
    assert.equal(s.getAgentMemoryCalls(), 1);
    assert.equal(s.getSourceCalls(), 0);
    assert.equal(s.getLastAgentMemory().conversationId, "sess");
    assert.equal(s.getLastAgentMemory().messages[2].role, "tool");
  });

  test("afterTurn preserves native user text and excludes runtime custom records", async (t) => {
    const s = await startBackend();
    t.after(async () => s.close());
    const eng = mkEngine(s.baseUrl, { flushEveryTurns: 1 });
    const quote = 'Sender (untrusted metadata):\n```json\n{"label":"quoted"}\n```\n[message_id: quoted-id]\nA literal marker: ⟦openclaw:ctx⟧';
    for (const content of [quote, [{ type: "text", text: quote }]]) {
      await eng.afterTurn({
        sessionKey: `native-user-${typeof content}`, prePromptMessageCount: 0,
        messages: [
          { role: "custom", customType: "openclaw.runtime-context", display: false, content: 'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"chat_id":"private-channel"}\n```', timestamp: 1788652800123 },
          { role: "user", content, timestamp: 1788652800123 },
          { role: "assistant", content: [{ type: "text", text: "Understood." }], stopReason: "stop", timestamp: 1788652800124 },
        ],
      });
      const messages = s.getLastAgentMemory().messages;
      assert.equal(messages.length, 2);
      assert.equal(messages[0].content, quote);
      assert.doesNotMatch(JSON.stringify(messages), /private-channel/);
    }
  });

  // LobsterAI (a packaged OpenClaw) wraps every prompt in its own session
  // instructions and appends a local-time block. Only the text under
  // [Current user request] is the user's.
  const LOBSTERAI_PROMPT = [
    "[LobsterAI system instructions]",
    "Apply the instructions below as the highest-priority guidance for this session.",
    "",
    "[Session info]",
    "Current model: lobsterai-server/deepseek-flash",
    "",
    "[Current user request]",
    "请记住：EverOS 测试 code 是 DURIAN-LOBSTER-81，只回复 noted",
    "",
    "<!-- lobsterai:local-time-context:v2 -->",
    "Local time: 2026-11-18T20:46:11+08:00 (Asia/Singapore), unix ms 1795005971711.",
    "<!-- /lobsterai:local-time-context:v2 -->",
  ].join("\n");

  test("afterTurn keeps only the user request out of a LobsterAI prompt", async (t) => {
    const s = await startBackend();
    t.after(async () => s.close());
    const eng = mkEngine(s.baseUrl, { flushEveryTurns: 1 });
    await eng.afterTurn({
      sessionKey: "lobsterai", prePromptMessageCount: 0,
      messages: [
        { role: "user", content: LOBSTERAI_PROMPT, timestamp: 1788652800123 },
        { role: "assistant", content: [{ type: "text", text: "noted" }], stopReason: "stop", timestamp: 1788652800124 },
      ],
    });
    assert.equal(s.getLastAgentMemory().messages[0].content, "请记住：EverOS 测试 code 是 DURIAN-LOBSTER-81，只回复 noted");
  });

  test("assemble searches with the LobsterAI user request only", async (t) => {
    const s = await startBackend({ searchResult: { episodes: [] } });
    t.after(async () => s.close());
    const eng = mkEngine(s.baseUrl);
    await eng.assemble({ sessionKey: "lobsterai-recall", messages: [], prompt: LOBSTERAI_PROMPT });
    assert.equal(s.getLastSearch().query, "请记住：EverOS 测试 code 是 DURIAN-LOBSTER-81，只回复 noted");
  });

  test("afterTurn keeps only the user request when a later LobsterAI prompt opens with session info", async (t) => {
    const s = await startBackend();
    t.after(async () => s.close());
    const eng = mkEngine(s.baseUrl, { flushEveryTurns: 1 });
    const later = "[Session info]\nCurrent model: lobsterai-server/deepseek-flash\n\n[Current user request]\n查下 Devin 的 code";
    await eng.afterTurn({
      sessionKey: "lobsterai-session-info", prePromptMessageCount: 0,
      messages: [
        { role: "user", content: later, timestamp: 1788652800123 },
        { role: "assistant", content: [{ type: "text", text: "DURIAN" }], stopReason: "stop", timestamp: 1788652800124 },
      ],
    });
    assert.equal(s.getLastAgentMemory().messages[0].content, "查下 Devin 的 code");
  });

  test("afterTurn drops the LobsterAI local-time block from a later prompt", async (t) => {
    const s = await startBackend();
    t.after(async () => s.close());
    const eng = mkEngine(s.baseUrl, { flushEveryTurns: 1 });
    const later = "what is the code?\n\n<!-- lobsterai:local-time-context:v2 -->\nLocal time: 2026-11-18T20:47:00+08:00.\n<!-- /lobsterai:local-time-context:v2 -->";
    await eng.afterTurn({
      sessionKey: "lobsterai-later", prePromptMessageCount: 0,
      messages: [
        { role: "user", content: later, timestamp: 1788652800123 },
        { role: "assistant", content: [{ type: "text", text: "DURIAN" }], stopReason: "stop", timestamp: 1788652800124 },
      ],
    });
    assert.equal(s.getLastAgentMemory().messages[0].content, "what is the code?");
  });

  test("afterTurn selects the latest user turn and removes system and runtime custom records", async (t) => {
    const s = await startBackend();
    t.after(async () => s.close());
    const eng = mkEngine(s.baseUrl, { flushEveryTurns: 1 });
    const rows = readFileSync(new URL("./fixtures/openclaw-clean.trajectory.jsonl", import.meta.url), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const messages = rows.find((row) => row.type === "model.completed").data.messagesSnapshot;

    await eng.afterTurn({ sessionKey: "openclaw-clean-session", messages, prePromptMessageCount: 0 });

    const saved = s.getLastAgentMemory().messages;
    assert.deepEqual(saved.map((message) => message.role), ["user", "assistant", "tool", "assistant"]);
    assert.equal(saved[0].content, "check the weather");
    assert.doesNotMatch(JSON.stringify(saved), /internal system|orphan assistant|private-channel|private-user|msg-123/);
  });

  test("afterTurn preserves a trusted assistant/tool-only turn", async (t) => {
    const s = await startBackend();
    t.after(async () => s.close());
    const eng = mkEngine(s.baseUrl, { flushEveryTurns: 1 });

    await eng.afterTurn({
      sessionKey: "assistant-only-session",
      messages: [
        { role: "system", content: "internal" },
        { role: "assistant", content: "continuing work" },
        { role: "tool", toolCallId: "call-1", content: "result" },
      ],
    });

    const saved = s.getLastAgentMemory().messages;
    assert.deepEqual(saved.map((message) => message.role), ["assistant", "tool"]);
  });

  test("afterTurn does not fall back to sources when realtime save fails", async (t) => {
    const s = await startBackend({ failAgentMemory: true });
    t.after(async () => s.close());
    const eng = mkEngine(s.baseUrl, { flushEveryTurns: 1 });
    await eng.afterTurn({ sessionKey: "sess", messages: [{ role: "user", content: "hi" }] });
    assert.equal(s.getAgentMemoryCalls(), 1);
    assert.equal(s.getSourceCalls(), 0, "OpenClaw runtime must not create document sources on realtime failure");
  });

  test("compact and dispose flush pending extraction without repeating messages", async (t) => {
    const s = await startBackend();
    t.after(async () => s.close());
    const eng = mkEngine(s.baseUrl, { flushEveryTurns: 100 });
    await eng.afterTurn({ sessionKey: "sess", messages: [{ role: "user", content: "hi" }] });
    await eng.compact({ sessionKey: "sess" });
    await eng.dispose({ sessionKey: "sess" });
    assert.equal(s.getSourceCalls(), 0);
    assert.deepEqual(s.getAgentMemoryBodies().map((body) => body.messages.length), [1, 0, 0]);
    assert.deepEqual(s.getAgentMemoryBodies().map((body) => body.flush), [false, true, true]);
  });

  test("afterTurn flushes every Nth turn — interim turns send flush=false", async (t) => {
    const s = await startBackend();
    t.after(async () => s.close());
    const flushFlags = [];
    const eng = mkEngine(s.baseUrl, { flushEveryTurns: 3 });
    // Simulate a real OpenClaw host: the messages array grows with
    // each turn. With prePromptMessageCount set to the previous
    // length, the engine slices off the newly-added tail and writes
    // it — never short-circuiting on an empty tail.
    const allMessages = [];
    for (let i = 1; i <= 6; i++) {
      const prePromptMessageCount = allMessages.length;
      allMessages.push({ role: "user", timestamp: 1710000000000 + i, content: "msg " + i });
      await eng.afterTurn({
        sessionKey: "sess",
        messages: allMessages,
        prePromptMessageCount,
      });
      flushFlags.push(s.getLastAgentMemory().flush);
    }
    // turn 1,2 → no flush; turn 3 → flush; turn 4,5 → no flush; turn 6 → flush.
    assert.deepEqual(flushFlags, [false, false, true, false, false, true]);
    assert.equal(s.getAgentMemoryCalls(), 6);
  });

  test("default cadence flushes every fifth turn", async (t) => {
    const s = await startBackend();
    t.after(async () => s.close());
    const eng = mkEngine(s.baseUrl);
    const allMessages = [];
    for (let i = 1; i <= 5; i++) {
      const prePromptMessageCount = allMessages.length;
      allMessages.push({ role: "user", content: `turn ${i}` });
      await eng.afterTurn({ sessionKey: "sess", messages: allMessages, prePromptMessageCount });
    }

    assert.deepEqual(s.getAgentMemoryBodies().map((body) => body.flush), [false, false, false, false, true]);
  });

  test("legacy flush mode restores every-turn extraction", async (t) => {
    const s = await startBackend();
    t.after(async () => s.close());
    const eng = mkEngine(s.baseUrl, { flushEveryTurns: 5, flushMode: "legacy" });
    const messages = [{ role: "user", content: "one" }];
    await eng.afterTurn({ sessionKey: "sess", messages, prePromptMessageCount: 0 });
    messages.push({ role: "user", content: "two" });
    await eng.afterTurn({ sessionKey: "sess", messages, prePromptMessageCount: 1 });

    assert.deepEqual(s.getAgentMemoryBodies().map((body) => body.flush), [true, true]);
  });

  test("flushEveryTurns=0 disables turn uploads but keeps lifecycle flush", async (t) => {
    const s = await startBackend();
    t.after(async () => s.close());
    const eng = mkEngine(s.baseUrl, { flushEveryTurns: 0, flushMaxBytes: 0 });
    for (let i = 0; i < 5; i++) {
      await eng.afterTurn({ sessionKey: "sess", messages: [{ role: "user", content: "x" + i }] });
    }
    assert.equal(s.getSourceCalls(), 0, "0 disables auto flush");
    await eng.compact({ sessionKey: "sess" });
    await eng.dispose({ sessionKey: "sess" });
    assert.equal(s.getSourceCalls(), 0);
    assert.deepEqual(s.getAgentMemoryBodies().map((body) => body.messages.length), [0, 0]);
    assert.deepEqual(s.getAgentMemoryBodies().map((body) => body.flush), [true, true]);
  });

  test("missing token at construction throws", () => {
    assert.throws(
      () => createContextEngine(pluginMeta, { apiBase: "http://x", agentId: "agt_x" }),
      /EVERME_AGENT_TOKEN/,
    );
  });
});

describe("durable turn advancement (OpenClaw 2026.8+)", () => {
  const turn = (prefix, timestamp) => [
    { role: "user", timestamp, content: `${prefix} question` },
    { role: "assistant", timestamp: timestamp + 1, stopReason: "toolUse", content: [{ type: "toolCall", id: `${prefix}-call`, name: "read", arguments: { path: "a" } }] },
    { role: "toolResult", timestamp: timestamp + 2, toolCallId: `${prefix}-call`, content: [{ type: "text", text: "file body" }] },
    { role: "assistant", timestamp: timestamp + 3, stopReason: "stop", content: [{ type: "text", text: `${prefix} answer` }] },
  ];
  const writes = (backend) => backend.getAgentMemoryBodies().filter((body) => body.messages.length);

  test("declares the transcript semantics OpenClaw requires and implements commitTurn", () => {
    const eng = mkEngine("http://127.0.0.1:9");
    assert.deepEqual(eng.info.transcriptSemantics, {
      currentTurnFence: "before-current-turn-entry-v1",
      turnAdvancementIdempotency: "atomic-idempotent-v1",
    });
    assert.equal(typeof eng.commitTurn, "function");
  });

  test("commitTurn writes a turn afterTurn never saw, and a host retry is a duplicate", async (t) => {
    const s = await startBackend();
    t.after(() => s.close());
    const messages = turn("only-commit", 1790000000000);
    const first = await mkEngine(s.baseUrl).commitTurn({ advancementKey: "turn-1", sessionKey: "commit-only", messages });
    assert.deepEqual(first, { status: "committed" });
    // The host retries from its outbox with a new engine instance.
    const retry = await mkEngine(s.baseUrl).commitTurn({ advancementKey: "turn-1", sessionKey: "commit-only", messages });
    assert.deepEqual(retry, { status: "duplicate" });
    assert.equal(writes(s).length, 1);
    assert.deepEqual(writes(s)[0].messages.map((message) => message.role), ["user", "assistant", "tool", "assistant"]);
    assert.equal(writes(s)[0].messages[1].toolCalls[0].id, "only-commit-call");
    assert.equal(writes(s)[0].conversationId, "commit-only");
  });

  test("afterTurn then commitTurn on the same turn writes it once", async (t) => {
    const s = await startBackend();
    t.after(() => s.close());
    const eng = mkEngine(s.baseUrl);
    const messages = turn("both", 1790000100000);
    await eng.afterTurn({ sessionKey: "both-paths", messages, prePromptMessageCount: 0 });
    // The transcript read hands commitTurn equal but distinct objects.
    const result = await eng.commitTurn({ advancementKey: "turn-both", sessionKey: "both-paths", messages: structuredClone(messages) });
    assert.deepEqual(result, { status: "committed" });
    assert.equal(writes(s).length, 1);
  });

  test("commitTurn writes what a failed afterTurn left behind", async (t) => {
    const s = await startBackend({ failAgentMemory: true });
    t.after(() => s.close());
    const messages = turn("retry", 1790000200000);
    await mkEngine(s.baseUrl).afterTurn({ sessionKey: "after-failed", messages, prePromptMessageCount: 0 });
    s.setFailAgentMemory(false);
    const result = await mkEngine(s.baseUrl).commitTurn({ advancementKey: "turn-retry", sessionKey: "after-failed", messages });
    assert.deepEqual(result, { status: "committed" });
    assert.equal(s.getAgentMemoryCalls(), 2);
    assert.equal(s.getLastAgentMemory().messages.length, 4);
  });

  test("commitTurn throws once so the host retries, then gives the turn up", async (t) => {
    const s = await startBackend({ failAgentMemory: true });
    t.after(() => s.close());
    const messages = turn("down", 1790000300000);
    const params = { advancementKey: "turn-down", sessionKey: "commit-down", messages };
    await assert.rejects(mkEngine(s.baseUrl).commitTurn(params));
    assert.deepEqual(await mkEngine(s.baseUrl).commitTurn(params), { status: "committed" });
    assert.deepEqual(await mkEngine(s.baseUrl).commitTurn(params), { status: "duplicate" });
    assert.equal(s.getAgentMemoryCalls(), 2);
  });

  test("heartbeat turns are acknowledged without a write", async (t) => {
    const s = await startBackend();
    t.after(() => s.close());
    const result = await mkEngine(s.baseUrl).commitTurn({
      advancementKey: "beat", sessionKey: "beat", messages: turn("beat", 1790000400000), isHeartbeat: true,
    });
    assert.deepEqual(result, { status: "committed" });
    assert.equal(s.getAgentMemoryCalls(), 0);
  });

  test("the session cursor survives the per-run engine, so later turns claim their turn", async (t) => {
    const s = await startBackend();
    t.after(() => s.close());
    const first = turn("first", 1790000500000);
    await mkEngine(s.baseUrl).afterTurn({ sessionKey: "per-run", messages: first, prePromptMessageCount: 0 });
    const both = [...first, ...turn("second", 1790000600000)];
    // OpenClaw builds a new engine for the next run.
    await mkEngine(s.baseUrl).afterTurn({ sessionKey: "per-run", messages: both, prePromptMessageCount: first.length });
    const third = turn("third", 1790000700000);
    await mkEngine(s.baseUrl).commitTurn({ advancementKey: "turn-3", sessionKey: "per-run", messages: third });
    assert.deepEqual(writes(s).map((body) => [body.baseTurn, body.turns]), [[0, 1], [undefined, 1], [undefined, 1]]);
  });

  test("a commit after an empty-history assemble anchors the session at turn 0", async (t) => {
    const s = await startBackend({ searchResult: { items: [], profiles: [] } });
    t.after(() => s.close());
    const messages = turn("new", 1790000900000);
    // The fenced assemble of a brand-new session sees no history.
    await mkEngine(s.baseUrl).assemble({ sessionKey: "brand-new", messages: [], prompt: "new question" });
    await mkEngine(s.baseUrl).commitTurn({ advancementKey: "new-1", sessionKey: "brand-new", messages });
    const second = turn("next", 1790001000000);
    await mkEngine(s.baseUrl).assemble({ sessionKey: "brand-new", messages, prompt: "next question" });
    await mkEngine(s.baseUrl).commitTurn({ advancementKey: "new-2", sessionKey: "brand-new", messages: second });
    assert.deepEqual(writes(s).map((body) => [body.baseTurn, body.turns]), [[0, 1], [undefined, 1]]);
  });

  for (const [outcome, fail, claims] of [
    ["may have landed is not claimed again", (s) => s.setDropAgentMemory(true), [[0, 1], [undefined, 1], [undefined, 0]]],
    ["the server refused is claimed again", (s) => s.setFailAgentMemory(true), [[0, 1], [undefined, 1], [undefined, 1]]],
  ]) {
    test(`a turn whose write ${outcome}`, async (t) => {
      const s = await startBackend();
      t.after(() => s.close());
      const sessionKey = `claim-${claims[2][1]}`;
      const first = turn("claim-first", 1790001100000);
      await mkEngine(s.baseUrl).afterTurn({ sessionKey, messages: first, prePromptMessageCount: 0 });
      const second = turn("claim-second", 1790001200000);
      fail(s);
      await mkEngine(s.baseUrl).afterTurn({ sessionKey, messages: [...first, ...second], prePromptMessageCount: first.length });
      s.setDropAgentMemory(false);
      s.setFailAgentMemory(false);
      // The host hands the same turn over again from its outbox.
      assert.deepEqual(
        await mkEngine(s.baseUrl).commitTurn({ advancementKey: `${sessionKey}-2`, sessionKey, messages: second }),
        { status: "committed" },
      );
      assert.deepEqual(writes(s).map((body) => [body.baseTurn, body.turns]), claims);
      assert.deepEqual(writes(s)[2].messages, writes(s)[1].messages);
    });
  }

  test("two engines that commit the same turn at once write it once", async (t) => {
    const s = await startBackend();
    t.after(() => s.close());
    const first = turn("race-first", 1790001300000);
    await mkEngine(s.baseUrl).afterTurn({ sessionKey: "race", messages: first, prePromptMessageCount: 0 });
    // OpenClaw 2026.8.1 hands a turn still in its outbox to the next run's
    // engine while the run that produced it is still committing it.
    s.setAgentMemoryDelay(50);
    const params = { advancementKey: "race-2", sessionKey: "race", messages: turn("race-second", 1790001400000) };
    const results = await Promise.all([
      mkEngine(s.baseUrl).commitTurn(params),
      mkEngine(s.baseUrl).commitTurn(structuredClone(params)),
    ]);
    assert.deepEqual(results.map((result) => result.status), ["committed", "duplicate"]);
    assert.deepEqual(writes(s).map((body) => [body.baseTurn, body.turns]), [[0, 1], [undefined, 1]]);
  });

  test("afterTurn and commitTurn on the same turn at once write it once", async (t) => {
    const s = await startBackend();
    t.after(() => s.close());
    const first = turn("overlap-first", 1790001500000);
    await mkEngine(s.baseUrl).afterTurn({ sessionKey: "overlap", messages: first, prePromptMessageCount: 0 });
    s.setAgentMemoryDelay(50);
    const second = turn("overlap-second", 1790001600000);
    await Promise.all([
      mkEngine(s.baseUrl).afterTurn({ sessionKey: "overlap", messages: [...first, ...second], prePromptMessageCount: first.length }),
      mkEngine(s.baseUrl).commitTurn({ advancementKey: "overlap-2", sessionKey: "overlap", messages: structuredClone(second) }),
    ]);
    assert.deepEqual(writes(s).map((body) => [body.baseTurn, body.turns]), [[0, 1], [undefined, 1]]);
  });

  test("a commit for a session this process never wrote claims nothing", async (t) => {
    const s = await startBackend();
    t.after(() => s.close());
    await mkEngine(s.baseUrl).commitTurn({ advancementKey: "cold", sessionKey: "cold-commit", messages: turn("cold", 1790000800000) });
    assert.equal(writes(s)[0].turns, 0);
    assert.ok(!Object.hasOwn(writes(s)[0], "baseTurn"));
  });
});

function nativeToolTurn(content, resultIds) {
  return [
    { role: "user", timestamp: 1787306400000, content: "Inspect the files." },
    { role: "assistant", timestamp: 1787306401000, content },
    ...resultIds.map((toolCallId, index) => ({
      role: "toolResult", timestamp: 1787306402000 + index, toolCallId,
      content: [{ type: "text", text: "Private source output." }],
    })),
    { role: "assistant", timestamp: 1787306404000, content: [{ type: "text", text: "Done." }] },
  ];
}
