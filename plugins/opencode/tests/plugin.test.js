import assert from "node:assert/strict";
import { describe, it } from "node:test";

import plugin, { createEvermePlugin, EvermePlugin } from "../src/plugin.js";

const CREDS = { configured: true, agentId: "agt_oc", agentToken: "evt_x", apiBase: "http://127.0.0.1:1", path: "/tmp/everme.env" };

function memoryStore() {
  const files = new Map();
  return {
    files,
    async withSession(_id, fn) { await fn(); return true; },
    async read(id) { return files.get(id) || { initialized: false, uploadedCount: 0 }; },
    async commit(id, uploadedCount, identity = {}) {
      files.set(id, { initialized: true, uploadedCount, ...identity });
    },
  };
}

function turn(n, { completed = true } = {}) {
  return [
    { info: { id: `msg_u${n}`, role: "user", time: { created: n * 10 } }, parts: [{ id: `p_u${n}`, type: "text", text: `question ${n}` }] },
    {
      info: { id: `msg_a${n}`, role: "assistant", parentID: `msg_u${n}`, time: { created: n * 10 + 1, ...(completed ? { completed: n * 10 + 2 } : {}) }, finish: "stop" },
      parts: [{ id: `p_a${n}`, type: "text", text: `answer ${n}` }],
    },
  ];
}

function setup({ messages = [], parentID, uploadImpl, idleCoalesceMs = 0, credentials = CREDS, profile = "<everme_profile>\np\n</everme_profile>", recall = "<everme_recall>\nr\n</everme_recall>" } = {}) {
  const uploads = [];
  const calls = { profile: 0, recall: 0 };
  const state = { messages };
  const store = memoryStore();
  const server = createEvermePlugin({
    loadCredentials: async () => credentials,
    fetchProfileBlock: async () => { calls.profile += 1; return profile; },
    fetchRecallBlock: async () => { calls.recall += 1; return recall; },
    uploadTurns: async (_c, payload) => {
      uploads.push(payload);
      if (uploadImpl) return uploadImpl(payload);
      return { status: "accepted" };
    },
    checkpointStore: store,
    idleCoalesceMs,
    log: { warn() {}, info() {} },
  });
  const client = {
    session: {
      messages: async () => ({ data: state.messages }),
      get: async () => ({ data: { id: "ses_1", ...(parentID ? { parentID } : {}) } }),
    },
  };
  return { server, client, uploads, calls, state, store };
}

describe("opencode plugin", () => {
  it("default-exports { id, server } for path plugins and a named export", () => {
    assert.equal(plugin.id, "everme");
    assert.equal(typeof plugin.server, "function");
    assert.equal(plugin.server, EvermePlugin);
  });

  it("injects the profile once per session into the system prompt", async () => {
    const { server, client, calls } = setup();
    const hooks = await server({ client }, { platform: "opencode" });
    const first = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "ses_1" }, first);
    const second = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "ses_1" }, second);
    await hooks["experimental.chat.system.transform"]({}, { system: [] });
    assert.equal(calls.profile, 1);
    assert.equal(first.system.at(-1), "<everme_profile>\np\n</everme_profile>");
    assert.equal(second.system.at(-1), "<everme_profile>\np\n</everme_profile>");
  });

  it("pushes recall as a synthetic text part with a host-format id", async () => {
    const { server, client } = setup();
    const hooks = await server({ client }, {});
    const output = { message: { id: "msg_u1" }, parts: [{ id: "prt_1", type: "text", text: "what did we decide" }] };
    await hooks["chat.message"]({ sessionID: "ses_1" }, output);
    assert.equal(output.parts.length, 2);
    const part = output.parts[1];
    assert.equal(part.type, "text");
    assert.equal(part.synthetic, true);
    assert.equal(part.sessionID, "ses_1");
    assert.equal(part.messageID, "msg_u1");
    assert.match(part.id, /^prt_[0-9a-f]{12}/);
    assert.ok(part.text.startsWith("<everme_recall>"));
  });

  it("fails open: a recall error adds nothing and does not throw", async () => {
    const server = createEvermePlugin({
      loadCredentials: async () => CREDS,
      fetchRecallBlock: async () => { throw new Error("down"); },
      checkpointStore: memoryStore(),
      log: { warn() {} },
    });
    const hooks = await server({ client: {} }, {});
    const output = { message: { id: "m" }, parts: [{ type: "text", text: "hello there friend" }] };
    await hooks["chat.message"]({ sessionID: "s" }, output);
    assert.equal(output.parts.length, 1);
  });

  it("does nothing without credentials", async () => {
    const { server, client, uploads, calls } = setup({ credentials: { configured: false }, messages: turn(1) });
    const hooks = await server({ client }, {});
    const output = { message: { id: "m" }, parts: [{ type: "text", text: "hello" }] };
    await hooks["chat.message"]({ sessionID: "s" }, output);
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });
    assert.equal(calls.recall, 0);
    assert.equal(uploads.length, 0);
    assert.equal(output.parts.length, 1);
  });

  it("captures a finished turn on idle, then only the next turn", async () => {
    const { server, client, uploads, state } = setup({ messages: turn(1) });
    const hooks = await server({ client }, { platform: "opencode" });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });
    assert.equal(uploads.length, 1);
    assert.deepEqual(uploads[0].messages.map((m) => m.content), ["question 1", "answer 1"]);
    assert.equal(uploads[0].conversationId, "ses_1");
    assert.equal(uploads[0].deduplication, "client-native-id");
    assert.equal(uploads[0].baseTurn, 0);
    assert.equal(uploads[0].turns, 1);
    for (const message of uploads[0].messages) assert.equal(message.sourceRecordId, undefined);

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });
    assert.equal(uploads.length, 1, "an unchanged session uploads nothing");

    state.messages = [...turn(1), ...turn(2)];
    await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } } });
    assert.equal(uploads.length, 2);
    assert.deepEqual(uploads[1].messages.map((m) => m.content), ["question 2", "answer 2"]);
    assert.equal(uploads[1].baseTurn, 1);
  });

  it("uploads only the newest turn of a session first seen mid-way", async () => {
    const { server, client, uploads } = setup({ messages: [...turn(1), ...turn(2)] });
    const hooks = await server({ client }, {});
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });
    assert.equal(uploads.length, 1);
    assert.deepEqual(uploads[0].messages.map((m) => m.content), ["question 2", "answer 2"]);
    assert.equal(uploads[0].baseTurn, undefined);
    assert.equal(uploads[0].turns, 0);
  });

  it("waits while the turn is still running", async () => {
    const { server, client, uploads } = setup({ messages: turn(1, { completed: false }) });
    const hooks = await server({ client }, {});
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });
    assert.equal(uploads.length, 0);
  });

  it("skips child sessions", async () => {
    const { server, client, uploads } = setup({ messages: turn(1), parentID: "ses_root" });
    const hooks = await server({ client }, {});
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });
    assert.equal(uploads.length, 0);
  });

  it("retries a rejected upload on the next idle, but commits a timed-out one", async () => {
    let fail = true;
    const { server, client, uploads } = setup({
      messages: turn(1),
      uploadImpl: () => {
        if (fail) throw Object.assign(new Error("500"), { type: "http" });
        return {};
      },
    });
    const hooks = await server({ client }, {});
    const idle = () => hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });
    await idle();
    fail = false;
    await idle();
    assert.equal(uploads.length, 2);
    assert.deepEqual(uploads[0].messages, uploads[1].messages);
    await idle();
    assert.equal(uploads.length, 2);

    const timed = setup({
      messages: turn(1),
      uploadImpl: () => { throw Object.assign(new Error("slow"), { type: "timeout" }); },
    });
    const hooks2 = await timed.server({ client: timed.client }, {});
    await hooks2.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });
    await hooks2.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });
    assert.equal(timed.uploads.length, 1);
  });

  it("captures once when session.status idle and session.idle arrive together", async () => {
    const { server, client, uploads, state } = setup({ messages: turn(1), idleCoalesceMs: 60_000 });
    let reads = 0;
    const messages = client.session.messages;
    client.session.messages = async (...args) => { reads += 1; return messages(...args); };
    const hooks = await server({ client }, {});
    await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } } });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });
    assert.equal(uploads.length, 1);
    assert.equal(reads, 1, "the second signal does not query the host");
    state.messages = [...turn(1), ...turn(2)];
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_2" } } });
    assert.equal(reads, 2, "another session is not coalesced");
  });

  it("waits for a running capture on dispose", async () => {
    let release;
    const { server, client, uploads, store } = setup({
      messages: turn(1),
      uploadImpl: () => new Promise((resolve) => { release = resolve; }),
    });
    const hooks = await server({ client }, {});
    hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });
    let disposed = false;
    const done = hooks.dispose().then(() => { disposed = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(uploads.length, 1);
    assert.equal(disposed, false);
    release({});
    await done;
    assert.ok(store.files.has("opencode:ses_1"), "the checkpoint is committed before dispose returns");
  });

  it("keys the checkpoint by platform", async () => {
    const { server, client, store } = setup({ messages: turn(1) });
    const hooks = await server({ client }, { platform: "kilocode" });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });
    assert.ok(store.files.has("kilocode:ses_1"));
  });
});
