import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createSessionState,
  createTranscriptCheckpointStore,
  createTurnCounter,
  EvermeError,
  PROFILE_MAX_CHARS,
  PROFILE_MAX_ITEMS,
  renderProfileBlock,
  resolveHookKnobs,
  runHook,
  sanitizeRecallQuery,
} from "../index.js";
import { runHostHook, withClientIdentity } from "../src/hooks/runtime.js";

const tempDirs = [];

// Delivery telemetry rides the same client as the memory writes. The fakes
// below measure the write contract, so they must not count reports as
// writes — every one of them would otherwise read one call too many.
const TELEMETRY_PATH = "/mem/import-events";
const isTelemetry = (requestPath) => requestPath === TELEMETRY_PATH;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("hook knobs", () => {
  test("uses the P0 defaults", () => {
    assert.deepEqual(resolveHookKnobs({}), {
      flushEveryTurns: 5,
      flushMode: "",
      injectTopK: 5,
      injectProfile: false,
      injectMinScore: 0.3,
      telemetry: true,
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
    assert.equal(knobs.injectTopK, 5);
    assert.equal(knobs.injectMinScore, 0.3);
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

    assert.deepEqual(await state.read("session"), { count: 0, lastTurnId: "", uploadedCount: 0, pendingTurn: null, lostTurns: 0 });

    await createTurnCounter({ stateDir }).commit("session", "turn-1");
    await state.patch("session", { uploadedCount: 7 });

    assert.deepEqual(await state.read("session"), { count: 1, lastTurnId: "turn-1", uploadedCount: 7, pendingTurn: null, lostTurns: 0 });
    const raw = JSON.parse(await readFile(path.join(stateDir, "session.json"), "utf8"));
    assert.equal(raw.uploadedCount, 7);
    assert.equal(raw.count, 1);
  });
});

describe("transcript checkpoint store", () => {
  test("round-trips optional native identities without migrating count-only state", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-checkpoint-"));
    tempDirs.push(stateDir);
    const store = createTranscriptCheckpointStore({ stateDir });
    await store.commit("qwenwork:new", 2, { nativeMessageIds: ["native-user", "native-answer"] });
    assert.deepEqual(await createTranscriptCheckpointStore({ stateDir }).read("qwenwork:new"), {
      initialized: true, uploadedCount: 2, nativeMessageIds: ["native-user", "native-answer"],
    });
    await store.commit("qwenwork:old", 2);
    assert.deepEqual(await store.read("qwenwork:old"), { initialized: true, uploadedCount: 2 });
  });
  test("persists an initialized zero offset separately from turn state", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-checkpoint-"));
    tempDirs.push(stateDir);
    const store = createTranscriptCheckpointStore({ stateDir });

    assert.deepEqual(await store.read("codex:session"), { initialized: false, uploadedCount: 0 });
    await store.commit("codex:session", 0);
    assert.deepEqual(await createTranscriptCheckpointStore({ stateDir }).read("codex:session"), {
      initialized: true,
      uploadedCount: 0,
    });
    assert.deepEqual((await readdir(stateDir)).sort(), ["codex_session.transcript.json"]);
  });
});

describe("host-neutral hook runtime", () => {
  const adapter = {
    platform: "test-host",
    // A Stop-per-turn host: it claims the hook channel and it runs the
    // delivery marker. Both halves of L1-2 hang off this one declaration, so
    // the fixture has to carry it for the loss-reporting tests below to be
    // about a writer that is actually in the numerator.
    turnBoundary: "stop",
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

  test("profile rows keep 500 chars and 60 items, spent facts-first", () => {
    const long = "字".repeat(900);
    const profile = {
      explicit_info: Array.from({ length: 58 }, (_, i) => ({
        category: "preference",
        description: i === 0 ? long : `fact ${i}`,
      })),
      implicit_traits: Array.from({ length: 10 }, (_, i) => ({
        trait: `t${i}`,
        description: `trait ${i}`,
      })),
    };
    const block = renderProfileBlock(profile);
    const rows = block.split("\n").filter((l) => l.startsWith("- "));

    assert.equal(rows.length, PROFILE_MAX_ITEMS, "the item budget is shared across both sections");
    // 58 facts spend most of the budget, so only 2 traits fit.
    assert.ok(block.includes("t0: trait 0"));
    assert.ok(block.includes("t1: trait 1"));
    assert.ok(!block.includes("t2: trait 2"), "traits past the shared budget are dropped");

    const longRow = rows.find((l) => l.includes("字"));
    // "- [preference] " prefix + PROFILE_MAX_CHARS of body (last char is the
    // ellipsis the truncator appends).
    assert.equal(longRow.length, "- [preference] ".length + PROFILE_MAX_CHARS);
    assert.ok(longRow.endsWith("…"));
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
    const delivery = [];
    const client = {
      async request(method, requestPath, body) {
        if (isTelemetry(requestPath)) {
          delivery.push(body.outcome);
          return { ok: true };
        }
        calls.push({ method, requestPath, body });
        return { flushed: body.flush };
      },
    };
    const counter = createTurnCounter({ stateDir });
    // Pin the delivery markers to the same temp dir as the counter: without
    // it the runtime falls back to EVERME_STATE_DIR (the real ~/.everme).
    const sessionState = createSessionState({ stateDir });
    const message = { role: "user", content: "hello" };

    await runHook("Stop", { sessionId: "session", turnId: "turn-1", messages: [message] }, adapter, {
      client,
      config: writeConfig,
      counter,
      sessionState,
    });
    await runHook("Stop", { sessionId: "session", turnId: "turn-1", messages: [message] }, adapter, {
      client,
      config: writeConfig,
      counter,
      sessionState,
    });
    for (let turn = 2; turn <= 5; turn += 1) {
      await runHook("Stop", { sessionId: "session", turnId: `turn-${turn}`, messages: [message] }, adapter, {
        client,
        config: writeConfig,
        counter,
        sessionState,
      });
    }

    assert.equal(calls.length, 6);
    assert.deepEqual(calls.map((call) => call.body.flush), [false, false, false, false, false, true]);
    assert.deepEqual(calls.map((call) => call.body.sync), [true, true, true, true, true, undefined]);
    assert.ok(calls.every((call) => call.requestPath === "/mem/agent-memory"));
    // Five turns landed and none of them reported: a delivered turn is
    // already counted server-side as an agent-memory write, so the happy path
    // must not spend a second request re-stating it.
    assert.deepEqual(delivery, []);
  });

  test("Stop trajectory writes claim the hook channel", async () => {
    // The gate only credits an explicit channel claim: without it a hook
    // write is indistinguishable from an MCP save_turn on the wire, lands in
    // everme_agent_memory_writes_total{source="unknown"} and never reaches
    // the L1-2 denominator.
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-runtime-"));
    tempDirs.push(stateDir);
    const calls = [];
    const client = {
      async request(method, requestPath, body) {
        if (isTelemetry(requestPath)) return { ok: true };
        calls.push(body);
        return { flushed: body.flush };
      },
    };
    const counter = createTurnCounter({ stateDir });
    const sessionState = createSessionState({ stateDir });
    const message = { role: "user", content: "hello" };

    await runHook("Stop", { sessionId: "session", turnId: "turn-1", messages: [message] }, adapter, {
      client,
      config: writeConfig,
      counter,
      sessionState,
    });
    await runHook("Stop", { sessionId: "session", turnId: "turn-2", messages: [message] }, adapter, {
      client,
      config: { ...writeConfig, flushMode: "legacy" },
      counter,
      sessionState,
    });

    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((body) => body.channel), ["hook", "hook"]);
  });

  test("SessionEnd whole-session uploads claim the hook channel with absolute turn coordinates", async () => {
    // A whole-session host holds the complete transcript, so its boundary
    // write can be addressed by absolute turn: the first upload starts at
    // turn 0, a later boundary continues at the ordinal of its first new
    // message. The claim is what gives the session gate a ledger row to
    // trim the importer's later scan of the same session against.
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

    assert.equal(calls.length, 1);
    assert.equal(calls[0].channel, "hook");
    assert.equal(calls[0].baseTurn, 0, "a first upload starts at turn 0");
    assert.equal(calls[0].turns, 1, "user + answer completes one turn");

    // The session ends again with two more messages: only the delta goes
    // out, addressed at the ordinal where it starts.
    const resumed = [
      ...session,
      { role: "user", content: "and then?" },
      { role: "assistant", content: "then this" },
    ];
    await runHook("SessionEnd", { sessionId: "session", session: resumed }, sessionAdapter, {
      client,
      config: writeConfig,
      sessionState,
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[1].messages.length, 2, "only the messages past the high-water mark");
    assert.equal(calls[1].channel, "hook");
    assert.equal(calls[1].baseTurn, 1, "the continuation is addressed by its absolute ordinal");
    assert.equal(calls[1].turns, 1);
  });

  test("Stop trajectory writes declare exactly one logical turn", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-runtime-"));
    tempDirs.push(stateDir);
    const calls = [];
    const client = {
      async request(method, requestPath, body) {
        if (isTelemetry(requestPath)) return { ok: true };
        calls.push(body);
        return { flushed: body.flush };
      },
    };
    await runHook("Stop", {
      sessionId: "session",
      turnId: "turn-1",
      messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }],
    }, adapter, { client, config: writeConfig, counter: createTurnCounter({ stateDir }), sessionState: createSessionState({ stateDir }) });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].turns, 1);
  });

  test("per-turn batch adapters claim the hook channel and declare the turn on the last batch", async () => {
    // claude-code and codex write through readStoreBatches. Until now that
    // path never claimed the channel, so the two largest hosts landed in
    // source="unknown" and never reached L1-2's denominator even though
    // they run the delivery marker and report lost turns.
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-batches-"));
    tempDirs.push(stateDir);
    const calls = [];
    const client = {
      async request(_method, requestPath, body) {
        if (isTelemetry(requestPath)) return { ok: true };
        calls.push(body);
        return { flushed: false };
      },
    };
    const batchAdapter = {
      ...adapter,
      turnBoundary: "stop",
      async readStoreBatches() {
        return [
          { conversationId: "root", messages: [{ role: "user", content: "first" }] },
          { conversationId: "root", messages: [{ role: "assistant", content: "second" }] },
        ];
      },
    };

    await runHook("Stop", { sessionId: "root", turnId: "turn-1" }, batchAdapter, {
      client,
      config: { ...writeConfig, flushEveryTurns: 0 },
      env: { EVERME_STATE_DIR: stateDir },
      writeStderr() {},
    });

    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((body) => body.channel), ["hook", "hook"]);
    assert.deepEqual(calls.map((body) => body.turns), [0, 1], "one Stop is one logical turn, declared once on the last batch");
  });

  test("batch adapters without a per-turn boundary stay unclaimed", async () => {
    // kimicode persists the whole root session at SessionEnd through the same
    // batch path. It has no per-turn writer and no delivery marker, so it can
    // never report a lost turn and must not enter L1-2's denominator.
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-batches-"));
    tempDirs.push(stateDir);
    const calls = [];
    const client = {
      async request(_method, requestPath, body) {
        if (isTelemetry(requestPath)) return { ok: true };
        calls.push(body);
        return { flushed: false };
      },
    };
    const sessionBatchAdapter = {
      ...adapter,
      turnBoundary: undefined,
      async readStoreBatches() {
        return [{ conversationId: "root", messages: [{ role: "user", content: "whole session" }] }];
      },
    };

    await runHook("Stop", { sessionId: "root", turnId: "turn-1" }, sessionBatchAdapter, {
      client,
      config: { ...writeConfig, flushEveryTurns: 0 },
      env: { EVERME_STATE_DIR: stateDir },
      writeStderr() {},
    });

    assert.equal(calls.length, 1);
    assert.equal(Object.hasOwn(calls[0], "channel"), false);
    assert.equal(Object.hasOwn(calls[0], "turns"), false);
  });

  // L1-2 is writes{source="hook"} / (writes{source="hook"} + lost_prev). The
  // claim that puts a writer in the numerator and the delivery marker that
  // lets it report the denominator's losses are two halves of ONE decision,
  // and they used to be taken in two places: the claim in runStoreBatches
  // (gated on turnBoundary) and the marker in runStore (gated on nothing).
  // The marker therefore ran before the code even knew which path it would
  // take, so a non-per-turn writer reported losses it had no numerator for
  // and drove L1-2 down by up to the ratio between the two populations.
  // Prod measured source="unknown" at 74.6% of trajectory turns against
  // source="hook" at 2.9%, i.e. losses divided by a numerator ~27x too small.
  //
  // These three tests pin the invariant: in the numerator IFF reporting
  // losses. Never one without the other.
  test("a batch that counts its own turns keeps that count", async () => {
    // qwenwork's checkpoint delta can rescue several turns in one write after
    // a Stop the host never delivered, so it counts them itself. The
    // per-turn default (turns:1 on the last batch, 0 on the rest) is for
    // adapters that do NOT count, and must not overwrite one that does:
    // reporting a two-turn rescue as one turn undercounts L1-2's numerator by
    // exactly the turn just recovered.
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-batches-"));
    tempDirs.push(stateDir);
    const calls = [];
    const client = {
      async request(_method, requestPath, body) {
        if (isTelemetry(requestPath)) return { ok: true };
        calls.push(body);
        return { flushed: false };
      },
    };
    const countingAdapter = {
      ...adapter,
      turnBoundary: "stop",
      async readStoreBatches() {
        return [{ conversationId: "root", messages: [{ role: "user", content: "rescued" }], channel: "hook", turns: 2 }];
      },
    };

    await runHook("Stop", { sessionId: "root", turnId: "turn-1" }, countingAdapter, {
      client,
      config: { ...writeConfig, flushEveryTurns: 0 },
      counter: createTurnCounter({ stateDir }),
      sessionState: createSessionState({ stateDir }),
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].channel, "hook");
    assert.equal(calls[0].turns, 2, "the adapter counted two rescued turns; the default must not clobber it");
  });

  test("batch adapters without a per-turn boundary report no losses", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-batches-"));
    tempDirs.push(stateDir);
    const delivery = [];
    const client = {
      async request(_method, requestPath, body) {
        if (isTelemetry(requestPath)) {
          if (body.event === "turn_delivery") delivery.push(body.outcome);
          return { ok: true };
        }
        return { flushed: false };
      },
    };
    const sessionBatchAdapter = {
      ...adapter,
      turnBoundary: undefined,
      async readStoreBatches() {
        return [{ conversationId: "root", messages: [{ role: "user", content: "whole session" }] }];
      },
    };
    const sessionState = createSessionState({ stateDir });
    // A marker left behind by a previous invocation, plus a carried debt: the
    // two ways a loss reaches telemetry.
    await sessionState.patch("root", { pendingTurn: { startedAt: Date.now(), turnId: "turn-0" }, lostTurns: 3 });

    await runHook("Stop", { sessionId: "root", turnId: "turn-1" }, sessionBatchAdapter, {
      client,
      config: { ...writeConfig, flushEveryTurns: 0 },
      counter: createTurnCounter({ stateDir }),
      sessionState,
    });

    assert.deepEqual(delivery, [], "this writer never claims the hook channel, so its losses have no numerator to land in");
  });

  test("adapters without a per-turn boundary claim the hook channel and declare the turns they carry", async () => {
    // A host whose write events are not 1:1 with turns (devin fires several
    // per answer) still claims the channel -- an unclaimed write is
    // anonymous to the session gate and its turns re-land on import -- but
    // it declares the user messages the write actually carries instead of
    // 1 per invocation. Counting per invocation once declared one turn PER
    // TOOL CALL and inflated L1-2's numerator, the failure that reads as
    // health.
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-pertool-"));
    tempDirs.push(stateDir);
    const calls = [];
    const client = {
      async request(_method, requestPath, body) {
        if (isTelemetry(requestPath)) return { ok: true };
        calls.push(body);
        return { flushed: body.flush };
      },
    };
    const perToolAdapter = { ...adapter, turnBoundary: undefined };
    const counter = createTurnCounter({ stateDir });
    const sessionState = createSessionState({ stateDir });

    await runHook("Stop", { sessionId: "session", turnId: "turn-1", messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }] }, perToolAdapter, {
      client, config: writeConfig, counter, sessionState,
    });
    // A follow-up event that adds no user message completes no turn.
    await runHook("Stop", { sessionId: "session", turnId: "turn-2", messages: [{ role: "assistant", content: "one more thing" }] }, perToolAdapter, {
      client, config: writeConfig, counter, sessionState,
    });

    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((body) => body.channel), ["hook", "hook"], "every write is claimed");
    assert.deepEqual(calls.map((body) => body.turns), [1, 0], "turns follow the user messages carried, not the invocation count");
  });

  test("adapters without a per-turn boundary leave no delivery marker", async () => {
    // The marker is what a later turn turns into a lost_prev. Writing one for
    // a writer that will never be in the numerator is how the asymmetry got
    // in, so the marker must not be written at all.
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-pertool-"));
    tempDirs.push(stateDir);
    const delivery = [];
    const client = {
      async request(_method, requestPath, body) {
        if (isTelemetry(requestPath)) {
          // A failed write also emits hook_degraded; only turn_delivery
          // outcomes are L1-2's business.
          if (body.event === "turn_delivery") delivery.push(body.outcome);
          return { ok: true };
        }
        throw new Error("gateway unreachable");
      },
    };
    const perToolAdapter = { ...adapter, turnBoundary: undefined };
    const counter = createTurnCounter({ stateDir });
    const sessionState = createSessionState({ stateDir });

    await runHook("Stop", { sessionId: "session", turnId: "turn-1", messages: [{ role: "user", content: "hi" }] }, perToolAdapter, {
      client,
      config: writeConfig,
      counter,
      sessionState,
    });
    assert.equal((await sessionState.read("session")).pendingTurn, null, "a write this writer lost is not L1-2's business");

    await runHook("Stop", { sessionId: "session", turnId: "turn-2", messages: [{ role: "user", content: "hi" }] }, perToolAdapter, {
      client,
      config: writeConfig,
      counter,
      sessionState,
    });
    assert.deepEqual(delivery, [], "nothing carried, so nothing reported");
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

  // A host whose boundary fires per tool call cannot afford to wait on the
  // upstream extraction: it is ~30x slower than the un-flushed write and
  // blows every hook budget. Such a host opts out and the gateway promotes
  // the session on its own.
  test("boundaryFlush:false enqueues the whole session instead of flushing", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-boundary-"));
    tempDirs.push(stateDir);
    const calls = [];
    const client = {
      async request(method, requestPath, body) {
        calls.push({ requestPath, body });
        return { status: "queued" };
      },
    };
    const perTurnAdapter = {
      ...adapter,
      boundaryFlush: false,
      async readSession(input) {
        return input.session || [];
      },
    };
    const session = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];

    // The wire body is the contract here: runHook's return value passes
    // through adapter.formatOutput, which owns the host-facing shape and
    // drops the internal flags.
    await runHook("SessionEnd", { sessionId: "session", session }, perTurnAdapter, {
      client,
      config: writeConfig,
      sessionState: createSessionState({ stateDir }),
    });

    assert.equal(calls.length, 1, "still exactly one write");
    assert.equal(calls[0].requestPath, "/mem/agent-memory");
    assert.equal(calls[0].body.flush, false, "the write must not block on extraction");
    assert.equal(calls[0].body.messages.length, 2, "and must still carry the session");
  });

  // The opt-out must be opt-IN: a whole-session host has exactly one write
  // per session, so waiting for extraction once is the right trade and must
  // not change just because another host needed the other behaviour.
  test("an adapter that does not opt out keeps flushing at the boundary", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-boundary-"));
    tempDirs.push(stateDir);
    const calls = [];
    const client = {
      async request(method, requestPath, body) {
        calls.push(body);
        return { flushed: true };
      },
    };
    const wholeSessionAdapter = {
      ...adapter,
      async readSession() {
        return [{ role: "user", content: "hello" }];
      },
    };

    await runHook("SessionEnd", { sessionId: "session" }, wholeSessionAdapter, {
      client,
      config: writeConfig,
      sessionState: createSessionState({ stateDir }),
    });

    assert.equal(calls[0].flush, true, "a once-per-session boundary still flushes");
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
        if (isTelemetry(requestPath)) return { ok: true };
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
    const delivery = [];
    const client = {
      async request(method, requestPath, body) {
        if (isTelemetry(requestPath)) {
          delivery.push(body);
          return { ok: true };
        }
        if (fail) throw new EvermeError({ message: "gateway down", status: 502, code: 50301 });
        calls.push(body);
        return { flushed: body.flush };
      },
    };
    const counter = createTurnCounter({ stateDir });
    const sessionState = createSessionState({ stateDir });
    const input = { sessionId: "session", turnId: "turn-1", messages: [{ role: "user", content: "hello" }] };

    await runHook("Stop", input, adapter, { client, config: writeConfig, counter, sessionState, writeStderr() {} });
    // The failed attempt leaves a delivery marker behind but must not consume
    // the turn id — the marker is evidence, the turn id is the dedup key.
    assert.deepEqual(await counter.peek("session", "turn-1"), { count: 1, duplicate: false });
    assert.equal((await sessionState.read("session")).pendingTurn?.turnId, "turn-1");

    fail = false;
    await runHook("Stop", input, adapter, { client, config: writeConfig, counter, sessionState });

    assert.equal(calls.length, 1, "retry with the same turn id must reach the gateway");
    assert.equal(calls[0].messages.length, 1);
    assert.deepEqual(await counter.peek("session", "turn-1"), { count: 1, duplicate: true });
    // The failed attempt reports the degradation the stderr line would
    // otherwise be the only record of; the retry then reports a recovery
    // rather than a loss, because it carries the marker's own turn id.
    assert.deepEqual(delivery.map((event) => event.event), ["hook_degraded", "turn_delivery"]);
    assert.equal(delivery[0].code, "50301");
    assert.equal(delivery[0].outcome, undefined, "hook_degraded must not carry an outcome");
    assert.equal(delivery[1].outcome, "recovered");
    assert.equal((await sessionState.read("session")).pendingTurn, null);
  });

  test("a turn killed mid-upload is reported as lost by the next turn", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-runtime-"));
    tempDirs.push(stateDir);
    const delivery = [];
    const client = {
      async request(method, requestPath, body) {
        if (isTelemetry(requestPath)) {
          delivery.push(body.outcome);
          return { ok: true };
        }
        return { flushed: body.flush };
      },
    };
    const counter = createTurnCounter({ stateDir });
    const sessionState = createSessionState({ stateDir });

    // What a SIGKILL during turn-1's upload leaves on disk: the marker, and
    // nothing else. The process never reached its commit or its stderr.
    await sessionState.patch("session", { pendingTurn: { startedAt: Date.now(), turnId: "turn-1" } });

    await runHook("Stop", { sessionId: "session", turnId: "turn-2", messages: [{ role: "user", content: "hi" }] }, adapter, {
      client,
      config: writeConfig,
      counter,
      sessionState,
    });

    assert.deepEqual(delivery, ["lost_prev"], "only the dead turn is reported; the one that landed is not");
    assert.equal((await sessionState.read("session")).pendingTurn, null);
  });

  test("a turn killed while deriving its turn id still counts as lost", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-runtime-"));
    tempDirs.push(stateDir);
    const delivery = [];
    const client = {
      async request(method, requestPath, body) {
        if (isTelemetry(requestPath)) {
          delivery.push(body.outcome);
          return { ok: true };
        }
        return { flushed: body.flush };
      },
    };
    const counter = createTurnCounter({ stateDir });
    const sessionState = createSessionState({ stateDir });
    // The host that actually carries this risk has NO native turn id, so
    // resolveTurnId reads the transcript to derive one (Claude Code takes the
    // last event uuid) and readLastTurn reads it again. Both are I/O the
    // watchdog can kill. Passing an explicit turnId here would short-circuit
    // resolveTurnId and test nothing.
    const derivingAdapter = {
      ...adapter,
      async resolveTurnId() {
        throw new Error("killed while deriving the turn id from the transcript");
      },
    };

    await runHook("Stop", { sessionId: "session", messages: [{ role: "user", content: "hi" }] }, derivingAdapter, {
      client,
      config: writeConfig,
      counter,
      sessionState,
      writeStderr() {},
    });
    assert.ok((await sessionState.read("session")).pendingTurn,
      "a turn killed while deriving its id must still leave evidence");

    await runHook("Stop", { sessionId: "session", turnId: "turn-2", messages: [{ role: "user", content: "hi" }] }, adapter, {
      client,
      config: writeConfig,
      counter,
      sessionState,
    });
    assert.ok(delivery.includes("lost_prev"), "the turn that died before parsing must be reported");
  });

  test("a turn killed while its transcript is parsed still counts as lost", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-runtime-"));
    tempDirs.push(stateDir);
    const delivery = [];
    const client = {
      async request(method, requestPath, body) {
        if (isTelemetry(requestPath)) {
          delivery.push(body.outcome);
          return { ok: true };
        }
        return { flushed: body.flush };
      },
    };
    const counter = createTurnCounter({ stateDir });
    const sessionState = createSessionState({ stateDir });
    const dyingAdapter = {
      ...adapter,
      async readLastTurn() {
        throw new Error("killed while reading the transcript");
      },
    };

    await runHook("Stop", { sessionId: "session", turnId: "turn-1" }, dyingAdapter, {
      client,
      config: writeConfig,
      counter,
      sessionState,
      writeStderr() {},
    });
    assert.equal((await sessionState.read("session")).pendingTurn?.turnId, "turn-1");

    await runHook("Stop", { sessionId: "session", turnId: "turn-2", messages: [{ role: "user", content: "hi" }] }, adapter, {
      client,
      config: writeConfig,
      counter,
      sessionState,
    });
    assert.ok(delivery.includes("lost_prev"), "the turn that died during parse must be reported");
  });

  test("a Stop with nothing to upload is not a lost turn", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-runtime-"));
    tempDirs.push(stateDir);
    const delivery = [];
    const client = {
      async request(method, requestPath, body) {
        if (isTelemetry(requestPath)) {
          delivery.push(body.outcome);
          return { ok: true };
        }
        return { flushed: body.flush };
      },
    };
    const counter = createTurnCounter({ stateDir });
    const sessionState = createSessionState({ stateDir });

    // Marking before the parse means the empty case has to clean up after
    // itself, or every drained Stop invents a loss for the next turn.
    await runHook("Stop", { sessionId: "session", turnId: "turn-1", messages: [] }, adapter, {
      client,
      config: writeConfig,
      counter,
      sessionState,
    });
    assert.equal((await sessionState.read("session")).pendingTurn, null);

    await runHook("Stop", { sessionId: "session", turnId: "turn-2", messages: [{ role: "user", content: "hi" }] }, adapter, {
      client,
      config: writeConfig,
      counter,
      sessionState,
    });
    assert.deepEqual(delivery, [], "an empty Stop is not a turn and must not be reported as lost");
  });

  test("a loss telemetry could not deliver is retried by a later turn", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-runtime-"));
    tempDirs.push(stateDir);
    let telemetryDown = true;
    const delivery = [];
    const client = {
      async request(method, requestPath, body) {
        if (isTelemetry(requestPath)) {
          if (telemetryDown) throw new Error("telemetry unreachable");
          delivery.push(body.outcome);
          return { ok: true };
        }
        return { flushed: body.flush };
      },
    };
    const counter = createTurnCounter({ stateDir });
    const sessionState = createSessionState({ stateDir });
    await sessionState.patch("session", { pendingTurn: { startedAt: Date.now(), turnId: "turn-1" } });

    // Reporting used to clear the marker first, so a report that failed took
    // the only evidence with it — completeness read highest exactly during
    // the outage destroying it.
    await runHook("Stop", { sessionId: "session", turnId: "turn-2", messages: [{ role: "user", content: "hi" }] }, adapter, {
      client,
      config: writeConfig,
      counter,
      sessionState,
    });
    assert.deepEqual(delivery, [], "the gateway never accepted it");
    assert.equal((await sessionState.read("session")).lostTurns, 1, "the debt has to survive the failed report");

    telemetryDown = false;
    await runHook("Stop", { sessionId: "session", turnId: "turn-3", messages: [{ role: "user", content: "hi" }] }, adapter, {
      client,
      config: writeConfig,
      counter,
      sessionState,
    });
    assert.deepEqual(delivery, ["lost_prev"], "the carried loss is reported once telemetry recovers");
    assert.equal((await sessionState.read("session")).lostTurns, 0);
  });

  test("an inherited loss survives a turn that dies deriving its id", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-runtime-"));
    tempDirs.push(stateDir);
    const delivery = [];
    const client = {
      async request(method, requestPath, body) {
        if (isTelemetry(requestPath)) {
          // The dying turn also emits hook_degraded, which owns no outcome.
          if (body.event === "turn_delivery") delivery.push(body.outcome);
          return { ok: true };
        }
        return { flushed: body.flush };
      },
    };
    const counter = createTurnCounter({ stateDir });
    const sessionState = createSessionState({ stateDir });
    const derivingAdapter = {
      ...adapter,
      async resolveTurnId() {
        throw new Error("killed while deriving the turn id from the transcript");
      },
    };

    // Turn A died mid-upload and left its marker. Turn B now overwrites that
    // marker with its own before it can know whether A was a loss or a replay
    // - and then B dies too. Writing the provisional marker without banking
    // A's loss first merged two lost turns into one.
    await sessionState.patch("session", { pendingTurn: { startedAt: Date.now(), turnId: "turn-a" } });
    await runHook("Stop", { sessionId: "session", messages: [{ role: "user", content: "hi" }] }, derivingAdapter, {
      client,
      config: writeConfig,
      counter,
      sessionState,
      writeStderr() {},
    });
    assert.equal((await sessionState.read("session")).lostTurns, 1,
      "turn A's loss must be banked before its marker is overwritten");

    // Two turns were lost, so two reports must come out - one per turn.
    for (const turnId of ["turn-c", "turn-d"]) {
      await runHook("Stop", { sessionId: "session", turnId, messages: [{ role: "user", content: "hi" }] }, adapter, {
        client,
        config: writeConfig,
        counter,
        sessionState,
      });
    }
    assert.deepEqual(delivery, ["lost_prev", "lost_prev"], "both lost turns are reported, not merged into one");
    assert.equal((await sessionState.read("session")).lostTurns, 0);
  });

  test("a replayed turn hands back the debt taken on for its marker", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-runtime-"));
    tempDirs.push(stateDir);
    const delivery = [];
    const client = {
      async request(method, requestPath, body) {
        if (isTelemetry(requestPath)) {
          delivery.push(body.outcome);
          return { ok: true };
        }
        return { flushed: body.flush };
      },
    };
    const counter = createTurnCounter({ stateDir });
    const sessionState = createSessionState({ stateDir });

    // The marker is provisionally counted as a loss before the turn id is
    // known. This one turns out to be the same turn replayed, so the debt has
    // to be handed back rather than reported.
    await sessionState.patch("session", { pendingTurn: { startedAt: Date.now(), turnId: "turn-1" } });
    await runHook("Stop", { sessionId: "session", turnId: "turn-1", messages: [{ role: "user", content: "hi" }] }, adapter, {
      client,
      config: writeConfig,
      counter,
      sessionState,
    });

    assert.deepEqual(delivery, ["recovered"], "a replay is a recovery, never a loss");
    assert.equal((await sessionState.read("session")).lostTurns, 0, "the provisional debt must not linger");
  });

  test("a long telemetry outage does not truncate the loss backlog", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-runtime-"));
    tempDirs.push(stateDir);
    let telemetryDown = true;
    const delivery = [];
    const client = {
      async request(method, requestPath, body) {
        if (isTelemetry(requestPath)) {
          if (telemetryDown) throw new Error("telemetry unreachable");
          delivery.push(body.outcome);
          return { ok: true };
        }
        return { flushed: body.flush };
      },
    };
    const counter = createTurnCounter({ stateDir });
    const sessionState = createSessionState({ stateDir });

    // Every one of these turns dies mid-upload, so each leaves a marker the
    // next one inherits as a loss. An earlier version capped the debt at 10,
    // which would have silently discarded the rest - understating losses in
    // exactly the incident that produced them.
    const losses = 25;
    for (let turn = 1; turn <= losses; turn += 1) {
      await sessionState.patch("session", { pendingTurn: { startedAt: Date.now(), turnId: `dead-${turn}` } });
      await runHook("Stop", { sessionId: "session", turnId: `turn-${turn}`, messages: [{ role: "user", content: "hi" }] }, adapter, {
        client,
        config: writeConfig,
        counter,
        sessionState,
      });
    }
    assert.deepEqual(delivery, [], "the gateway accepted none of them");
    assert.equal((await sessionState.read("session")).lostTurns, losses,
      "every loss has to survive the outage, not just the first ten");

    telemetryDown = false;
    await runHook("Stop", { sessionId: "session", turnId: "turn-after", messages: [{ role: "user", content: "hi" }] }, adapter, {
      client,
      config: writeConfig,
      counter,
      sessionState,
    });
    assert.deepEqual(delivery, ["lost_prev"], "one per turn, so the backlog drains without blowing the hook budget");
    assert.equal((await sessionState.read("session")).lostTurns, losses - 1);
  });

  test("a reported loss is not counted twice by the turn after it", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-runtime-"));
    tempDirs.push(stateDir);
    const delivery = [];
    const client = {
      async request(method, requestPath, body) {
        if (isTelemetry(requestPath)) {
          delivery.push(body.outcome);
          return { ok: true };
        }
        return { flushed: body.flush };
      },
    };
    const counter = createTurnCounter({ stateDir });
    const sessionState = createSessionState({ stateDir });
    await sessionState.patch("session", { pendingTurn: { startedAt: Date.now(), turnId: "turn-1" } });

    for (const turnId of ["turn-2", "turn-3"]) {
      await runHook("Stop", { sessionId: "session", turnId, messages: [{ role: "user", content: "hi" }] }, adapter, {
        client,
        config: writeConfig,
        counter,
        sessionState,
      });
    }

    assert.deepEqual(delivery, ["lost_prev"], "one loss, reported once, and nothing from the two turns that landed");
  });

  test("multi-conversation Stop commits each checkpoint only after its upload succeeds", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-batches-"));
    tempDirs.push(stateDir);
    const checkpointStore = createTranscriptCheckpointStore({ stateDir });
    const calls = [];
    let failChild = true;
    const client = {
      async request(_method, requestPath, body) {
        if (isTelemetry(requestPath)) return { ok: true };
        calls.push(body.conversationId);
        if (body.conversationId === "child" && failChild) {
          failChild = false;
          throw new Error("child failed");
        }
        return { flushed: false };
      },
    };
    const batchAdapter = {
      ...adapter,
      async readStoreBatches(_input, { checkpointStore: store }) {
        const batches = [];
        for (const conversationId of ["root", "child"]) {
          const stateId = `test:${conversationId}`;
          const state = await store.read(stateId);
          if (!state.initialized) {
            batches.push({
              conversationId,
              messages: [{ role: "assistant", content: conversationId }],
              checkpoint: { stateId, uploadedCount: 1 },
            });
          }
        }
        return batches;
      },
    };
    const env = { EVERME_STATE_DIR: stateDir };

    const first = await runHook("Stop", { sessionId: "root", turnId: "turn" }, batchAdapter, {
      client,
      config: { ...writeConfig, flushEveryTurns: 0 },
      checkpointStore,
      env,
      writeStderr() {},
    });
    assert.equal(first.count, 0);
    assert.deepEqual(await checkpointStore.read("test:root"), { initialized: true, uploadedCount: 1 });
    assert.deepEqual(await checkpointStore.read("test:child"), { initialized: false, uploadedCount: 0 });

    const second = await runHook("Stop", { sessionId: "root", turnId: "turn" }, batchAdapter, {
      client,
      config: { ...writeConfig, flushEveryTurns: 0 },
      checkpointStore,
      env,
    });
    assert.equal(second.count, 1);
    assert.deepEqual(calls, ["root", "child", "child"]);
    assert.deepEqual(await checkpointStore.read("test:child"), { initialized: true, uploadedCount: 1 });
  });

  test("legacy flush mode issues one combined messages+flush request per turn", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-runtime-"));
    tempDirs.push(stateDir);
    const calls = [];
    const client = {
      async request(method, requestPath, body) {
        if (isTelemetry(requestPath)) return { ok: true };
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
      { client, config: legacyConfig, counter, sessionState: createSessionState({ stateDir }) },
    );

    assert.equal(calls.length, 1, "legacy mode must be a single memory write per turn");
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

  // A dead or revoked evt refuses the write AND the loss report that would
  // follow it — both ride the same credential. Carrying the refusal as turn
  // debt means the whole credential outage lands on L1-2 later, as one
  // lost_prev spike the moment the credential is fixed: capture completeness
  // blamed retroactively for a credential problem. The refusal belongs to the
  // credential panel, which counts it server-side already via memauth.
  test("a write refused for its credential is not carried as a lost turn", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-runtime-"));
    tempDirs.push(stateDir);
    const delivery = [];
    const degraded = [];
    let refuse = true;
    const client = {
      async request(method, requestPath, body) {
        if (isTelemetry(requestPath)) {
          // Split the two events on purpose: hook_degraded carries no outcome,
          // so lumping them together would read a degradation as a delivery
          // report and hide whichever one this test is about.
          if (body.event === "turn_delivery") delivery.push(body.outcome);
          if (body.event === "hook_degraded") degraded.push(body.hookEvent);
          return { ok: true };
        }
        if (refuse) {
          throw new EvermeError({ message: "Invalid agent token", status: 401, code: 30301, type: "auth" });
        }
        return { flushed: body.flush };
      },
    };
    const counter = createTurnCounter({ stateDir });
    const sessionState = createSessionState({ stateDir });

    // Turn 1 is refused. Whether the hook throws is not what this measures —
    // what matters is that it leaves no loss-bearing marker behind.
    await runHook("Stop", { sessionId: "session", turnId: "turn-1", messages: [{ role: "user", content: "hi" }] }, adapter, {
      client, config: writeConfig, counter, sessionState,
    }).catch(() => {});
    assert.equal((await sessionState.read("session")).pendingTurn, null,
      "a refused credential must not leave the turn marked in flight");

    // The credential is fixed and a new turn lands.
    refuse = false;
    await runHook("Stop", { sessionId: "session", turnId: "turn-2", messages: [{ role: "user", content: "hi" }] }, adapter, {
      client, config: writeConfig, counter, sessionState,
    });

    assert.deepEqual(delivery, [], "a credential refusal is not a capture loss");
    // Suppressing the turn-loss must not make the failure invisible: it is
    // still a degraded hook, and that is the signal that stays.
    assert.ok(degraded.length > 0, "the refusal is still reported as a degraded hook");
  });

  // The batched path is the one that matters in production: claude-code and
  // codex both write through readStoreBatches, and codex is the largest
  // import source on prod. A refusal there must be suppressed the same way,
  // or the fix only covers the two smallest hosts.
  test("a batched write refused for its credential is not carried as a lost turn", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-runtime-"));
    tempDirs.push(stateDir);
    const delivery = [];
    let refuse = true;
    const client = {
      async request(_method, requestPath, body) {
        if (isTelemetry(requestPath)) {
          if (body.event === "turn_delivery") delivery.push(body.outcome);
          return { ok: true };
        }
        if (refuse) {
          throw new EvermeError({ message: "Invalid agent token", status: 401, code: 30301, type: "auth" });
        }
        return { flushed: body.flush };
      },
    };
    const batchAdapter = {
      ...adapter,
      turnBoundary: "stop",
      async readStoreBatches() {
        return [{ conversationId: "root", messages: [{ role: "user", content: "first" }] }];
      },
    };
    const counter = createTurnCounter({ stateDir });
    const sessionState = createSessionState({ stateDir });

    await runHook("Stop", { sessionId: "session", turnId: "turn-1", messages: [{ role: "user", content: "hi" }] }, batchAdapter, {
      client, config: writeConfig, counter, sessionState,
    }).catch(() => {});
    assert.equal((await sessionState.read("session")).pendingTurn, null,
      "a refused credential must not leave the batched turn marked in flight");

    refuse = false;
    await runHook("Stop", { sessionId: "session", turnId: "turn-2", messages: [{ role: "user", content: "hi" }] }, batchAdapter, {
      client, config: writeConfig, counter, sessionState,
    });

    assert.deepEqual(delivery, [], "a credential refusal is not a capture loss on the batched path either");
  });
});

test("withClientIdentity stamps hook/<adapter.version> onto the client config", () => {
  const cfg = withClientIdentity({ baseUrl: "http://x", deadlineAt: 123 }, { platform: "claude-code", version: "0.6.4" });
  assert.equal(cfg.clientKind, "hook");
  assert.equal(cfg.clientVersion, "0.6.4");
  assert.equal(cfg.deadlineAt, 123, "existing fields survive");
});

test("withClientIdentity tolerates an adapter without a version", () => {
  const cfg = withClientIdentity({ baseUrl: "http://x" }, { platform: "legacy" });
  assert.equal(cfg.clientKind, "hook");
  assert.equal(cfg.clientVersion, "");
});

// Every runHook-based test in this file injects deps.client directly, which
// short-circuits createClient entirely and can never observe the config
// withClientIdentity built. runHostHook is exported separately and, unlike
// runHook, uses deps.createClient exactly as passed (no override), so this
// is the seam that actually exercises the runtime.js call site and would
// catch a revert of the withClientIdentity wiring there.
test("runHostHook feeds withClientIdentity's config to createClient (regression guard for the runtime.js wiring)", async () => {
  const adapter = {
    platform: "test-host",
    version: "1.2.3",
    normalizeInput(rawInput) {
      return rawInput;
    },
    formatOutput(event, { block = "", count = 0 } = {}) {
      return { ok: true, event, block, count };
    },
  };
  const config = {
    isConfigured: true,
    authMode: "emk",
    agentId: "",
    agentToken: "emk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    injectTopK: 10,
    injectProfile: false,
    injectMinScore: 0.1,
    flushEveryTurns: 5,
  };

  let capturedConfig = null;
  await runHostHook("SessionStart", { sessionId: "session" }, adapter, {
    config,
    // No deps.client here: that would bypass createClient and hide a
    // reverted withClientIdentity call just like the real fleet would.
    createClient(cfg) {
      capturedConfig = cfg;
      return { async request() { return {}; } };
    },
    runSessionStart: async () => ({ block: "", count: 0 }),
  });

  assert.ok(capturedConfig, "createClient must have been invoked with the runtime's config");
  assert.equal(capturedConfig.clientKind, "hook");
  assert.equal(capturedConfig.clientVersion, "1.2.3");
});
