import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createContextEngine } from "../src/engine.js";

const pluginMeta = { id: "@everme/openclaw", name: "EverMe", version: "0.1.0" };

/**
 * Minimal everme-shaped backend that responds to /mem/context and
 * /mem/uploads/presign + /mem/sources (so flush works).
 */
function startBackend({ contextResult, searchResult, failAgentMemory = false } = {}) {
  let presignCalls = 0;
  let sourceCalls = 0;
  let agentMemoryCalls = 0;
  let lastAgentMemory = null;
  const agentMemoryBodies = [];
  let searchCalls = 0;
  let lastSearch = null;

  const srv = http.createServer((req, res) => {
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
        if (failAgentMemory) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "upstream down", status: 50101, requestId: "r" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "ok",
          status: 0,
          result: { status: "accumulated", messageCount: lastAgentMemory.messages?.length || 0, flushed: true },
        }));
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
    assert.match(r.systemPromptAddition, /Recent raw messages/);
    assert.match(r.systemPromptAddition, /Agent skills/);
    // And the per-row content survives the renderer.
    assert.match(r.systemPromptAddition, /Wangcai/);
    assert.match(r.systemPromptAddition, /旺财/);
    assert.match(r.systemPromptAddition, /京都看樱花/);
    assert.match(r.systemPromptAddition, /双文件协同记忆更新/);
    assert.ok(r.estimatedTokens > 0);
    // The default body should expand memoryTypes to all four — the
    // gateway default — by leaving the field unset here. (Plugin
    // doesn't narrow today; if it ever does, this is the boundary
    // test that flags the change.)
    assert.equal(s.getLastSearch().memoryTypes, undefined);
  });

  test("assemble skips on /clear", async (t) => {
    const s = await startBackend();
    t.after(async () => s.close());
    const eng = mkEngine(s.baseUrl);
    const r = await eng.assemble({ sessionKey: "sess", messages: [], prompt: "/clear" });
    assert.equal(r.systemPromptAddition, undefined);
    assert.equal(r.estimatedTokens, 0);
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
