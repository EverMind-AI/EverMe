import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createSessionState,
  createTurnCounter,
  EvermeError,
  resolveHookKnobs,
  runHook,
  sanitizeRecallQuery,
} from "../index.js";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("hook knobs", () => {
  test("uses the P0 defaults", () => {
    assert.deepEqual(resolveHookKnobs({}), {
      flushEveryTurns: 5,
      flushMode: "",
      injectTopK: 10,
      injectProfile: false,
      injectMinScore: 0.1,
    });
  });

  test("clamps numeric settings and honors legacy mode", () => {
    const knobs = resolveHookKnobs({
      EVERME_FLUSH_EVERY_TURNS: "999999999999999999999",
      EVERME_FLUSH_MODE: " LEGACY ",
      EVERME_INJECT_TOPK: "-4",
      EVERME_INJECT_PROFILE: "true",
      EVERME_INJECT_MIN_SCORE: "-0.5",
    });

    assert.equal(knobs.flushEveryTurns, 1);
    assert.equal(knobs.flushMode, "legacy");
    assert.equal(knobs.injectTopK, 1);
    assert.equal(knobs.injectProfile, true);
    assert.equal(knobs.injectMinScore, 0);
  });

  test("rejects partially numeric values", () => {
    const knobs = resolveHookKnobs({
      EVERME_FLUSH_EVERY_TURNS: "5turns",
      EVERME_INJECT_TOPK: "12items",
      EVERME_INJECT_MIN_SCORE: "0.2score",
    });

    assert.equal(knobs.flushEveryTurns, 5);
    assert.equal(knobs.injectTopK, 10);
    assert.equal(knobs.injectMinScore, 0.1);
  });
});

describe("recall query sanitizer", () => {
  test("removes injected blocks and a leading slash command", () => {
    assert.equal(
      sanitizeRecallQuery("/ask <everme_recall>old memory</everme_recall> 你好 世界"),
      "你好 世界",
    );
  });

  test("removes multiline profile blocks and folds mixed-language whitespace", () => {
    assert.equal(
      sanitizeRecallQuery(
        "/recall@everme\n<everme_profile>\nold profile\n</everme_profile>\n  OAuth   设计\t方案 ",
      ),
      "OAuth 设计 方案",
    );
  });
});

describe("turn counter", () => {
  test("persists commits, skips duplicate turn ids, and protects state files", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-state-"));
    tempDirs.push(stateDir);

    const firstProcess = createTurnCounter({ stateDir });
    assert.deepEqual(await firstProcess.peek("../../session one", "turn-1"), {
      count: 1,
      duplicate: false,
    });
    assert.deepEqual(await firstProcess.commit("../../session one", "turn-1"), {
      count: 1,
      duplicate: false,
    });
    assert.deepEqual(await firstProcess.peek("../../session one", "turn-1"), {
      count: 1,
      duplicate: true,
    });

    const secondProcess = createTurnCounter({ stateDir });
    assert.deepEqual(await secondProcess.peek("../../session one", "turn-2"), {
      count: 2,
      duplicate: false,
    });
    assert.deepEqual(await secondProcess.commit("../../session one", "turn-2"), {
      count: 2,
      duplicate: false,
    });

    const files = await readdir(stateDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^[a-zA-Z0-9._-]+\.json$/);
    const info = await stat(path.join(stateDir, files[0]));
    assert.equal(info.mode & 0o777, 0o600);
  });

  test("peek persists nothing until commit", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-state-"));
    tempDirs.push(stateDir);
    const counter = createTurnCounter({ stateDir });

    await counter.peek("session", "turn-1");
    assert.deepEqual(await readdir(stateDir), []);
  });

  test("state writes prune session files older than 30 days", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-state-"));
    tempDirs.push(stateDir);
    const staleFile = path.join(stateDir, "stale-session.json");
    const freshFile = path.join(stateDir, "fresh-session.json");
    await writeFile(staleFile, JSON.stringify({ count: 3, lastTurnId: "t" }));
    await writeFile(freshFile, JSON.stringify({ count: 1, lastTurnId: "t" }));
    const staleTime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await utimes(staleFile, staleTime, staleTime);

    await createTurnCounter({ stateDir }).commit("session", "turn-1");

    const files = (await readdir(stateDir)).sort();
    assert.deepEqual(files, ["fresh-session.json", "session.json"]);
  });
});

describe("session state", () => {
  test("stores the boundary upload high-water mark alongside turn state", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-state-"));
    tempDirs.push(stateDir);
    const state = createSessionState({ stateDir });

    assert.deepEqual(await state.read("session"), { count: 0, lastTurnId: "", uploadedCount: 0 });

    await createTurnCounter({ stateDir }).commit("session", "turn-1");
    await state.patch("session", { uploadedCount: 7 });

    assert.deepEqual(await state.read("session"), { count: 1, lastTurnId: "turn-1", uploadedCount: 7 });
    const raw = JSON.parse(await readFile(path.join(stateDir, "session.json"), "utf8"));
    assert.equal(raw.uploadedCount, 7);
    assert.equal(raw.count, 1);
  });
});

describe("host-neutral hook runtime", () => {
  const adapter = {
    platform: "test-host",
    normalizeInput(rawInput) {
      return rawInput;
    },
    async readLastTurn(input) {
      return input.messages || [];
    },
    formatOutput(event, { block = "", count = 0 } = {}) {
      return { ok: true, event, block, count };
    },
  };

  const readConfig = {
    isConfigured: true,
    authMode: "emk",
    agentId: "",
    agentToken: "emk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    injectTopK: 10,
    injectProfile: false,
    injectMinScore: 0.1,
    flushEveryTurns: 5,
  };

  const writeConfig = {
    ...readConfig,
    authMode: "evt",
    agentId: "agt_test",
    agentToken: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };

  test("SessionStart renders the profile snapshot", async () => {
    const client = {
      async request(method, requestPath, body) {
        assert.equal(method, "POST");
        assert.equal(requestPath, "/mem/context");
        assert.deepEqual(body, {});
        return {
          profile: {
            explicit_info: [{ category: "preference", description: "Prefers Go" }],
            implicit_traits: [{ trait: "careful", description: "Checks evidence" }],
          },
        };
      },
    };

    const out = await runHook("SessionStart", { sessionId: "session" }, adapter, {
      client,
      config: readConfig,
    });

    assert.match(out.block, /^<everme_profile>/);
    assert.match(out.block, /Prefers Go/);
    assert.match(out.block, /careful: Checks evidence/);
    assert.match(out.block, /<\/everme_profile>$/);
    assert.equal(out.count, 2);
  });

  test("UserPromptSubmit sanitizes the query and applies recall defaults", async () => {
    const calls = [];
    const client = {
      async request(method, requestPath, body) {
        calls.push({ method, requestPath, body });
        return {
          items: [
            { type: "episodic_memory", summary: "keep", score: 0.2 },
            { type: "episodic_memory", summary: "drop", score: 0.05 },
          ],
          profiles: [{ profileData: { embed_text: "hidden profile" } }],
          rawMessages: [],
          agentMemory: { cases: [], skills: [] },
        };
      },
    };

    const out = await runHook(
      "UserPromptSubmit",
      {
        sessionId: "session",
        prompt: "/ask <everme_recall>old</everme_recall> 请回忆 OAuth 方案",
      },
      adapter,
      { client, config: readConfig },
    );

    assert.deepEqual(calls[0].body, { query: "请回忆 OAuth 方案", topK: 10 });
    assert.match(out.block, /^<everme_recall>/);
    assert.match(out.block, /keep/);
    assert.doesNotMatch(out.block, /drop/);
    assert.doesNotMatch(out.block, /hidden profile/);
    assert.equal(out.count, 1);
  });

  test("dispatches aliases while preserving the host event in output", async () => {
    const seen = [];
    let searched = false;
    const aliasAdapter = {
      mapEvent: (event) => ({ BeforeAgent: "UserPromptSubmit" })[event] || event,
      normalizeInput(raw, event) {
        seen.push(["input", event]);
        return raw;
      },
      formatOutput(event, result) {
        seen.push(["output", event]);
        return result;
      },
    };

    await runHook(
      "BeforeAgent",
      { prompt: "remember the OAuth design" },
      aliasAdapter,
      {
        client: {},
        config: readConfig,
        async searchMemory() {
          searched = true;
          return { memories: [], profiles: [], rawMessages: [], agentMemory: { cases: [], skills: [] } };
        },
      },
    );

    assert.equal(searched, true);
    assert.deepEqual(seen.map((row) => row[1]), ["BeforeAgent", "BeforeAgent"]);
  });

  test("Stop enqueues every unique turn and flushes extraction at the cadence boundary", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-runtime-"));
    tempDirs.push(stateDir);
    const calls = [];
    const client = {
      async request(method, requestPath, body) {
        calls.push({ method, requestPath, body });
        return { flushed: body.flush };
      },
    };
    const counter = createTurnCounter({ stateDir });
    const message = { role: "user", content: "hello" };

    await runHook("Stop", { sessionId: "session", turnId: "turn-1", messages: [message] }, adapter, {
      client,
      config: writeConfig,
      counter,
    });
    await runHook("Stop", { sessionId: "session", turnId: "turn-1", messages: [message] }, adapter, {
      client,
      config: writeConfig,
      counter,
    });
    for (let turn = 2; turn <= 5; turn += 1) {
      await runHook("Stop", { sessionId: "session", turnId: `turn-${turn}`, messages: [message] }, adapter, {
        client,
        config: writeConfig,
        counter,
      });
    }

    assert.equal(calls.length, 6);
    assert.deepEqual(calls.map((call) => call.body.flush), [false, false, false, false, false, true]);
    assert.ok(calls.every((call) => call.requestPath === "/mem/agent-memory"));
  });

  test("SessionEnd and PreCompact issue flush-only requests", async () => {
    const calls = [];
    const client = {
      async request(method, requestPath, body) {
        calls.push({ method, requestPath, body });
        return { flushed: true };
      },
    };

    await runHook("SessionEnd", { sessionId: "session" }, adapter, { client, config: writeConfig });
    await runHook("PreCompact", { sessionId: "session" }, adapter, { client, config: writeConfig });

    assert.deepEqual(calls.map((call) => call.body), [
      { conversationId: "session", messages: [], flush: true },
      { conversationId: "session", messages: [], flush: true },
    ]);
  });

  test("SessionEnd carries the whole session when the adapter reads one", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-boundary-"));
    tempDirs.push(stateDir);
    const calls = [];
    const client = {
      async request(method, requestPath, body) {
        calls.push({ requestPath, body });
        return { flushed: true };
      },
    };
    const sessionAdapter = {
      ...adapter,
      async readSession(input) {
        return input.session || [];
      },
    };
    const session = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];

    await runHook("SessionEnd", { sessionId: "session", session }, sessionAdapter, {
      client,
      config: writeConfig,
      sessionState: createSessionState({ stateDir }),
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].requestPath, "/mem/agent-memory");
    assert.equal(calls[0].body.flush, true);
    assert.equal(calls[0].body.messages.length, 2);
  });

  test("a re-fired SessionEnd with no new messages uploads nothing", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-boundary-"));
    tempDirs.push(stateDir);
    const calls = [];
    const client = {
      async request(method, requestPath, body) {
        calls.push(body);
        return { flushed: true };
      },
    };
    const sessionAdapter = {
      ...adapter,
      async readSession(input) {
        return input.session || [];
      },
    };
    const sessionState = createSessionState({ stateDir });
    const session = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];

    await runHook("SessionEnd", { sessionId: "session", session }, sessionAdapter, {
      client,
      config: writeConfig,
      sessionState,
    });
    await runHook("SessionEnd", { sessionId: "session", session }, sessionAdapter, {
      client,
      config: writeConfig,
      sessionState,
    });

    assert.equal(calls.length, 1, "second SessionEnd must not re-upload the transcript");
  });

  test("a resumed session uploads only the messages past the high-water mark", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-boundary-"));
    tempDirs.push(stateDir);
    const calls = [];
    const client = {
      async request(method, requestPath, body) {
        calls.push(body);
        return { flushed: true };
      },
    };
    const sessionAdapter = {
      ...adapter,
      async readSession(input) {
        return input.session || [];
      },
    };
    const sessionState = createSessionState({ stateDir });
    const initial = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const resumed = [
      ...initial,
      { role: "user", content: "one more thing" },
      { role: "assistant", content: "done" },
    ];

    await runHook("SessionEnd", { sessionId: "session", session: initial }, sessionAdapter, {
      client,
      config: writeConfig,
      sessionState,
    });
    await runHook("SessionEnd", { sessionId: "session", session: resumed }, sessionAdapter, {
      client,
      config: writeConfig,
      sessionState,
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[1].messages.length, 2, "only the delta past the marker uploads");
    assert.match(calls[1].messages[0].content, /one more thing/);
    assert.equal(calls[1].flush, true);
  });

  test("the high-water mark does not advance when the boundary upload fails", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-boundary-"));
    tempDirs.push(stateDir);
    let fail = true;
    const calls = [];
    const client = {
      async request(method, requestPath, body) {
        calls.push(body);
        if (fail) throw new EvermeError({ message: "upstream write failed", status: 502, code: 50301 });
        return { flushed: true };
      },
    };
    const sessionAdapter = {
      ...adapter,
      async readSession(input) {
        return input.session || [];
      },
    };
    const sessionState = createSessionState({ stateDir });
    const session = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];

    await runHook("SessionEnd", { sessionId: "session", session }, sessionAdapter, {
      client,
      config: writeConfig,
      sessionState,
      writeStderr() {},
    });
    assert.equal((await sessionState.read("session")).uploadedCount, 0);

    fail = false;
    await runHook("SessionEnd", { sessionId: "session", session }, sessionAdapter, {
      client,
      config: writeConfig,
      sessionState,
    });

    assert.equal(calls.length, 2, "retry after failure re-uploads the session");
    assert.equal(calls[1].messages.length, 2);
    assert.equal((await sessionState.read("session")).uploadedCount, 2);
  });

  test("SessionEnd skips the write when the adapter session is empty", async () => {
    let called = false;
    const client = { async request() { called = true; } };
    const sessionAdapter = {
      ...adapter,
      async readSession() {
        return [];
      },
    };

    await runHook("SessionEnd", { sessionId: "session", session: [] }, sessionAdapter, {
      client,
      config: writeConfig,
    });

    assert.equal(called, false);
  });

  test("write events are disabled for EMK auth", async () => {
    let called = false;
    const client = { async request() { called = true; } };

    const out = await runHook(
      "Stop",
      { sessionId: "session", turnId: "turn", messages: [{ role: "user", content: "hello" }] },
      adapter,
      { client, config: readConfig },
    );

    assert.equal(called, false);
    assert.equal(out.ok, true);
  });

  test("Stop does not advance cadence when the adapter has no messages", async () => {
    let touches = 0;
    const counter = {
      async peek() {
        touches += 1;
        return { count: touches, duplicate: false };
      },
      async commit() {
        touches += 1;
        return { count: touches, duplicate: false };
      },
    };
    const client = { async request() { throw new Error("must not write"); } };

    await runHook("Stop", { sessionId: "empty", turnId: "turn-empty", messages: [] }, adapter, {
      client,
      config: writeConfig,
      counter,
    });

    assert.equal(touches, 0);
  });

  test("Stop leaves the turn retryable when the enqueue fails", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-runtime-"));
    tempDirs.push(stateDir);
    let fail = true;
    const calls = [];
    const client = {
      async request(method, requestPath, body) {
        if (fail) throw new EvermeError({ message: "gateway down", status: 502, code: 50301 });
        calls.push(body);
        return { flushed: body.flush };
      },
    };
    const counter = createTurnCounter({ stateDir });
    const input = { sessionId: "session", turnId: "turn-1", messages: [{ role: "user", content: "hello" }] };

    await runHook("Stop", input, adapter, { client, config: writeConfig, counter, writeStderr() {} });
    assert.deepEqual(await readdir(stateDir), [], "failed enqueue must not consume the turn id");

    fail = false;
    await runHook("Stop", input, adapter, { client, config: writeConfig, counter });

    assert.equal(calls.length, 1, "retry with the same turn id must reach the gateway");
    assert.equal(calls[0].messages.length, 1);
    assert.deepEqual(await counter.peek("session", "turn-1"), { count: 1, duplicate: true });
  });

  test("legacy flush mode issues one combined messages+flush request per turn", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-runtime-"));
    tempDirs.push(stateDir);
    const calls = [];
    const client = {
      async request(method, requestPath, body) {
        calls.push({ requestPath, body });
        return { flushed: body.flush };
      },
    };
    const counter = createTurnCounter({ stateDir });
    const legacyConfig = { ...writeConfig, flushMode: "legacy", flushEveryTurns: 1 };

    await runHook(
      "Stop",
      { sessionId: "session", turnId: "turn-1", messages: [{ role: "user", content: "hello" }] },
      adapter,
      { client, config: legacyConfig, counter },
    );

    assert.equal(calls.length, 1, "legacy mode must be a single wire request per turn");
    assert.equal(calls[0].requestPath, "/mem/agent-memory");
    assert.equal(calls[0].body.flush, true);
    assert.equal(calls[0].body.messages.length, 1);
    assert.match(calls[0].body.messages[0].content, /hello/);
  });

  test("backend errors fail open with a redacted single-line diagnostic", async () => {
    let stderr = "";
    const client = {
      async request() {
        throw new Error("backend rejected evt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nsecret detail");
      },
    };

    const out = await runHook("UserPromptSubmit", { prompt: "find my memory please" }, adapter, {
      client,
      config: writeConfig,
      writeStderr(line) {
        stderr += line;
      },
    });

    assert.equal(out.ok, true);
    assert.equal(out.block, "");
    assert.doesNotMatch(stderr, /evt_b{32}/);
    assert.match(stderr, /evt_bbbb_REDACTED/);
    assert.equal(stderr.match(/\n/g)?.length, 1);
  });
});
