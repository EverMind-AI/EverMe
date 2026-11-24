import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { batchUserTasks } from "../src/task-batches.js";
import {
  saveAgentMemory,
  flushAgentMemory,
  convertAgentMessage,
  EvermeError,
  MAX_MESSAGES_PER_REQUEST,
  turnOrdinals,
  splitTurnAligned,
  completedTurns,
} from "../index.js";

test("task batching is opt-in and preserves split flush and turn coordinates", async () => {
  const messages = [{ role: "user", content: "task", timestamp: 1 }];
  for (let i = 0; i < 251; i++) {
    messages.push({ role: "assistant", timestamp: i + 2, toolCalls: [{ id: String(i), type: "function", name: "exec", arguments: "{}" }] },
      { role: "tool", timestamp: i + 2, toolCallId: String(i), content: "x".repeat(5000) });
  }
  messages.push({ role: "assistant", content: "done", timestamp: 1000 });
  for (const taskBatching of [false, true]) {
    const requests = [];
    await saveAgentMemory({ async request(_method, _path, body) { requests.push(body); return {}; } }, {
      conversationId: "task", messages, baseTurn: 0, taskBatching, flush: true,
    });
    assert.ok(requests.length > 1);
    assert.ok(requests.slice(0, -1).every((request) => !request.flush && request.sync === true && request.turns === 0));
    assert.equal(requests.at(-1).flush, true);
    assert.equal(requests.at(-1).turns, 1);
    assert.ok(requests.every((request) => request.baseTurn === 0 && !Object.hasOwn(request, "taskBatching")));
    const results = requests.flatMap((request) => request.messages).filter((message) => message.role === "tool");
    assert.equal(results.length, 251);
    assert.ok(results.every((message) => taskBatching ? Buffer.byteLength(message.content) <= 2048 : message.content.length === 5000));
    if (taskBatching) assert.deepEqual(requests.map((request) => request.messages), batchUserTasks(messages.map((message) => convertAgentMessage(message))));
  }
});

describe("agent memory", () => {
  test("checks hook scope support before sending and retains scope across batches", async () => {
    const requests = [];
    const client = { async requestWithMeta(method, path, body) {
      requests.push({ method, path, body });
      return { result: path.endsWith("/state") ? { hookSyncScopeSupported: true } : {}, requestId: "request" };
    } };
    const messages = Array.from({ length: 502 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user", content: String(index), timestamp: index + 1,
    }));
    await saveAgentMemory(client, {
      conversationId: "session", syncScope: "fragment-one", channel: "hook",
      messages, baseTurn: 0, flush: true,
    });
    assert.deepEqual(requests[0], {
      method: "POST", path: "/mem/agent-memory/state",
      body: { sessions: [{ conversationId: "session", syncScope: "fragment-one" }] },
    });
    const writes = requests.slice(1).map(({ body }) => body);
    assert.ok(writes.length > 1);
    assert.ok(writes.every(body => body.syncScope === "fragment-one" && body.conversationId === "session"));
    assert.deepEqual(writes.flatMap(body => body.messages).map(message => message.content), messages.map(message => message.content));
    assert.equal(writes.at(-1).flush, true);
    assert.ok(writes.slice(0, -1).every(body => body.flush === false));
  });

  test("hook scope support cannot be inferred from import support or a prior invocation", async () => {
    let supported = true;
    const paths = [];
    const client = { async request(_method, path) {
      paths.push(path);
      return { syncScopeSupported: true, hookSyncScopeSupported: supported };
    } };
    const options = {
      conversationId: "session", syncScope: "fragment", channel: "hook",
      messages: [{ role: "user", content: "task" }],
    };
    await saveAgentMemory(client, options);
    supported = false;
    await assert.rejects(saveAgentMemory(client, options), /sync scope is not supported/);
    assert.deepEqual(paths, ["/mem/agent-memory/state", "/mem/agent-memory", "/mem/agent-memory/state"]);
  });

  test("unsupported or failed scope checks stop before any write", async () => {
    for (const response of [{}, { hookSyncScopeSupported: "true" }, new Error("state unavailable")]) {
      const paths = [];
      const client = { async request(_method, path) {
        paths.push(path);
        if (response instanceof Error) throw response;
        return response;
      } };
      await assert.rejects(saveAgentMemory(client, {
        conversationId: "session", syncScope: "fragment", channel: "hook",
        messages: [{ role: "user", content: "task" }],
      }), /sync scope is not supported|state unavailable/);
      assert.deepEqual(paths, ["/mem/agent-memory/state"]);
    }
  });

  test("optional scope preserves legacy requests and session-level flush", async () => {
    const requests = [];
    const client = { async request(_method, path, body) {
      requests.push({ path, body });
      return {};
    } };
    for (const syncScope of [undefined, ""]) {
      await saveAgentMemory(client, {
        conversationId: "session", syncScope, channel: "hook",
        messages: [{ role: "user", content: "task" }],
      });
    }
    await flushAgentMemory(client, { conversationId: "session" });
    assert.equal(requests.length, 3);
    assert.ok(requests.every(({ path, body }) => path === "/mem/agent-memory" && !Object.hasOwn(body, "syncScope")));
    assert.deepEqual(requests.at(-1).body, { conversationId: "session", messages: [], flush: true });
  });

  test("scoped import checks its own advertised capability", async () => {
    const paths = [];
    const client = { async request(_method, path) {
      paths.push(path);
      return { syncScopeSupported: true };
    } };
    await saveAgentMemory(client, {
      conversationId: "session", syncScope: "fragment", channel: "import",
      messages: [{ role: "user", content: "task" }],
    });
    assert.deepEqual(paths, ["/mem/agent-memory/state", "/mem/agent-memory"]);
  });

  test("forwards native deduplication on every split without positional coordinates", async () => {
    const requests = [];
    const messages = Array.from({ length: 502 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user", content: String(index), timestamp: index + 1,
    }));
    await saveAgentMemory({ request: async (_method, _path, body) => { requests.push(body); return {}; } }, {
      conversationId: "native", channel: "hook", deduplication: "client-native-id",
      messages, taskBatching: true, turns: 251,
    });
    assert.ok(requests.length > 1);
    assert.ok(requests.every((request) => request.deduplication === "client-native-id" && request.baseTurn === undefined));
    assert.deepEqual(requests.flatMap((request) => request.messages).map((message) => message.content), messages.map((message) => message.content));
  });
  test("carries explicit assistant completion to the gateway without inventing it", async () => {
    const final = { role: "assistant", content: "Done." };
    Object.defineProperty(final, "turnComplete", { value: true });
    const requests = [];
    await saveAgentMemory({ request: async (_method, _path, body) => { requests.push(body); return {}; } }, {
      conversationId: "session", flush: false,
      messages: [
        { role: "user", content: "Inspect.", turnComplete: true },
        { role: "assistant", content: "Working.", turnComplete: false },
        { role: "assistant", content: "Unknown phase." },
        final,
      ],
    });
    assert.deepEqual(requests[0].messages.map(message => message.turnComplete), [undefined, false, undefined, true]);
    assert.deepEqual(JSON.parse(JSON.stringify(requests[0])).messages.map(message => message.turnComplete), [undefined, false, undefined, true]);
    assert.equal(Object.keys(final).includes("turnComplete"), false);
  });

  for (const role of ["tool", "toolResult"]) {
    for (const [name, text] of [
      ["message ID and status", "Log: [message_id: native-id]\nstatus: failed\nEnd."],
      ["quoted metadata", 'Sender (untrusted metadata):\n```json\n{"label":"example"}\n```'],
      ["timestamp", "[2026-09-06 10:00:00 UTC+0] tool failed"],
    ]) {
      for (const [shape, content] of [
        ["string", text],
        ["parts", [{ type: "text", text }]],
        ["object", { text }],
        ["mixed parts", [text, { content: "tail" }]],
      ]) {
        test(`${role} preserves literal ${name} in ${shape}`, () => {
          const out = convertAgentMessage({ role, toolCallId: "native-call", content }, 1);
          assert.deepEqual(out, {
            role: "tool", timestamp: 1, toolCallId: "native-call",
            content: shape === "mixed parts" ? `${text}\ntail` : text,
          });
        });
      }
    }
    test(`${role} retains existing empty and whitespace normalization`, () => {
      for (const content of ["", " \n", null, undefined, [], {}]) {
        assert.equal(convertAgentMessage({ role, toolCallId: "native-call", content }, 1).content, "");
      }
      assert.equal(convertAgentMessage({ role, toolCallId: "native-call", content: "  log\n " }, 1).content, "log");
    });
  }

  test("tool results bypass the text cap without changing ordinary message budgets", async () => {
    const content = "\u59cb" + "\u6d4b".repeat(15999) + "\u7ec8";
    for (const role of ["tool", "toolResult"]) {
      const out = convertAgentMessage({ role, timestamp: 1710000000000, toolCallId: "long", content }, 1);
      assert.equal(out.content, content);
      assert.equal(out.toolCallId, "long");
    }
    for (const role of ["user", "assistant"]) {
      const out = convertAgentMessage({ role, content }, 1);
      assert.ok(Array.from(out.content).length <= 8000);
      assert.match(out.content, /trimmed \d+ chars/);
    }
    const requests = [];
    await saveAgentMemory({ request: async (_method, _path, body) => { requests.push(body); return {}; } }, {
      conversationId: "long-tool-result",
      messages: [
        { role: "assistant", toolCalls: [{ id: "long", name: "read", arguments: "{}" }] },
        { role: "tool", toolCallId: "long", content },
        { role: "assistant", content: "Finished." },
      ],
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].messages.length, 3);
    assert.equal(requests[0].messages[1].content, content);
  });

  test("convertAgentMessage preserves user text already classified by the host", () => {
    const enveloped =
      'Sender (untrusted metadata):\n```json\n{"label":"openclaw-feishu"}\n```\n\nremember my postgres index decision';
    const out = convertAgentMessage(
      { role: "user", timestamp: 1710000000000, content: enveloped },
      1,
    );
    assert.equal(out.content, enveloped);
  });

  test("convertAgentMessage preserves quoted channel metadata in assistant text", () => {
    const out = convertAgentMessage(
      {
        role: "assistant",
        timestamp: 1710000001000,
        content: [
          { type: "text", text: "Sender (untrusted metadata):\n```json\n{}\n```\nok, noted." },
        ],
      },
      2,
    );
    assert.equal(out.content, "Sender (untrusted metadata):\n```json\n{}\n```\nok, noted.");
  });

  for (const text of [
    "Log: [message_id: native-id]\nstatus: failed\nEnd.",
    "[2026-09-06 10:00:00 UTC+0] The task finished.",
  ]) {
    for (const content of [text, [{ type: "text", text }]]) {
      test(`assistant preserves literal protocol text in ${typeof content}`, () => {
        assert.equal(convertAgentMessage({ role: "assistant", content }, 1).content, text);
      });
    }
  }

  test("convertAgentMessage preserves tool trajectory", () => {
    const out = [
      convertAgentMessage({ role: "user", timestamp: 1710000000000, content: [{ type: "text", text: "weather?" }] }, 1),
      convertAgentMessage({
        role: "assistant",
        timestamp: 1710000001000,
        content: [
          { type: "text", text: "Let me check" },
          { type: "toolCall", id: "call_a", name: "get_weather", arguments: { city: "Tokyo" } },
        ],
      }, 2),
      convertAgentMessage({ role: "toolResult", timestamp: 1710000002000, toolCallId: "call_a", content: [{ type: "text", text: "18C" }] }, 3),
    ];

    assert.equal(out[0].role, "user");
    assert.equal(out[0].content, "weather?");
    assert.equal(out[1].role, "assistant");
    assert.equal(out[1].toolCalls[0].id, "call_a");
    assert.equal(out[1].toolCalls[0].arguments, '{"city":"Tokyo"}');
    assert.equal(out[2].role, "tool");
    assert.equal(out[2].toolCallId, "call_a");
  });

  test("saveAgentMemory posts to /mem/agent-memory", async () => {
    const calls = [];
    const client = {
      async request(method, path, body) {
        calls.push({ method, path, body });
        return { status: "accumulated", messageCount: body.messages.length, flushed: true };
      },
    };

    const res = await saveAgentMemory(client, {
      conversationId: "sess-1",
      flush: true,
      messages: [
        { role: "user", timestamp: 1710000000000, content: "hi" },
        { role: "assistant", timestamp: 1710000001000, content: "hello" },
      ],
    });

    assert.equal(res.messageCount, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].path, "/mem/agent-memory");
    assert.equal(calls[0].body.conversationId, "sess-1");
    assert.equal(calls[0].body.flush, true);
  });

  test("flushAgentMemory posts a flush-only request", async () => {
    const calls = [];
    const client = {
      async request(method, path, body) {
        calls.push({ method, path, body });
        return { status: "accumulated", messageCount: 0, flushed: true };
      },
    };

    const res = await flushAgentMemory(client, { conversationId: "sess-1" });

    assert.equal(res.flushed, true);
    assert.deepEqual(calls, [{
      method: "POST",
      path: "/mem/agent-memory",
      body: { conversationId: "sess-1", messages: [], flush: true },
    }]);
  });

  test("saveAgentMemory splits oversized uploads and flushes only on the last batch", async () => {
    const calls = [];
    const client = {
      async request(method, path, body) {
        calls.push({ method, path, body });
        return { status: "accumulated", messageCount: body.messages.length, flushed: body.flush };
      },
    };
    const messages = Array.from({ length: 1203 }, (_, i) => ({
      role: "user",
      timestamp: 1710000000000 + i,
      content: `message ${i}`,
    }));

    const res = await saveAgentMemory(client, { conversationId: "sess-big", messages, flush: true });

    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((call) => call.body.messages.length), [500, 500, 203]);
    assert.deepEqual(calls.map((call) => call.body.flush), [false, false, true]);
    // Leading batches must keep the synchronous-add guarantee (sync=true):
    // async leading batches can still be invisible to the final request's
    // flush — the first-flush data-loss shape, per request this time.
    assert.deepEqual(calls.map((call) => call.body.sync), [true, true, undefined]);
    assert.ok(calls.every((call) => call.path === "/mem/agent-memory" && call.body.conversationId === "sess-big"));
    assert.equal(calls[0].body.messages[0].content, "message 0");
    assert.equal(calls[2].body.messages[202].content, "message 1202");
    assert.equal(res.flushed, true);
    assert.equal(MAX_MESSAGES_PER_REQUEST, 500);
  });

  test("saveAgentMemory keeps flush=false on every batch when the caller did not flush", async () => {
    const calls = [];
    const client = {
      async request(method, path, body) {
        calls.push(body);
        return { flushed: body.flush };
      },
    };
    const messages = Array.from({ length: 501 }, (_, i) => ({
      role: "user",
      timestamp: 1710000000000 + i,
      content: `m${i}`,
    }));

    await saveAgentMemory(client, { conversationId: "sess-nf", messages, flush: false });

    assert.deepEqual(calls.map((body) => body.flush), [false, false]);
    assert.ok(calls.every((body) => body.sync === undefined),
      "append-only uploads must not force the sync path");
    assert.deepEqual(calls.map((body) => body.messages.length), [500, 1]);
  });

  test("saveAgentMemory preserves the available 498-message turn boundary", async () => {
    const calls = [];
    const client = { async request(_method, _path, body) { calls.push(body); return {}; } };
    const messages = [
      { role: "user", content: "first question", turnId: "first" },
      ...Array.from({ length: 497 }, () => ({ role: "assistant", content: "first answer", turnId: "first" })),
      { role: "user", content: "second question", turnId: "second" },
      { role: "assistant", toolCalls: [{ id: "c", name: "shell", arguments: "{}" }], turnId: "second" },
      { role: "tool", toolCallId: "c", content: "", turnId: "second" },
      { role: "assistant", content: "done", turnId: "second", turnComplete: true },
    ];
    await saveAgentMemory(client, { conversationId: "s", messages, sync: true, flush: false });
    assert.deepEqual(calls.map((body) => body.messages.length), [498, 4]);
    assert.deepEqual(calls.map((body) => body.sync), [true, true]);
    assert.equal(calls[1].messages[2].content, "");
    assert.ok(calls.flatMap((body) => body.messages).every((message) => !Object.hasOwn(message, "turnId")));
    assert.equal(calls[1].messages.at(-1).turnComplete, true);
  });

  test("saveAgentMemory surfaces a mid-batch failure instead of silent success", async () => {
    const calls = [];
    const client = {
      async request(method, path, body) {
        calls.push(body);
        if (calls.length === 2) {
          throw new EvermeError({ message: "server rejected batch", status: 500, code: 50301 });
        }
        return { flushed: body.flush };
      },
    };
    const messages = Array.from({ length: 1100 }, (_, i) => ({
      role: "user",
      timestamp: 1710000000000 + i,
      content: `m${i}`,
    }));

    await assert.rejects(
      saveAgentMemory(client, { conversationId: "sess-fail", messages, flush: true }),
      (error) => {
        // Assert the numeric code, not the message: upstream error copy is
        // known to be misleading (e.g. errno 50301's text).
        assert.equal(error.code, 50301);
        assert.equal(error.httpStatus, 500);
        return true;
      },
    );
    assert.equal(calls.length, 2, "stops at the failing batch; no further batches sent");
    assert.equal(calls[0].flush, false, "no flush was issued before the failure");
  });

  test("agent-memory diagnostics are bounded and never include message content", async () => {
    const lines = [];
    const client = {
      async request() {
        throw new Error(`upstream ${"e".repeat(1000)}`);
      },
    };
    const privateContent = "private-user-message-never-log";

    await assert.rejects(saveAgentMemory(client, {
      conversationId: `session-${"s".repeat(300)}`,
      messages: Array.from({ length: MAX_MESSAGES_PER_REQUEST + 1 }, () => ({
        role: "user",
        content: privateContent,
      })),
    }, {
      info: (line) => lines.push(line),
      warn: (line) => lines.push(line),
    }));

    assert.ok(lines.every((line) => !line.includes(privateContent)));
    assert.ok(lines.every((line) => line.length < 700), `unbounded log: ${Math.max(...lines.map((line) => line.length))}`);
    assert.ok(lines.some((line) => line.includes("stage=batch result=failed")));
  });

  test("saveAgentMemory permits an explicit flush-only request", async () => {
    const calls = [];
    const client = {
      async request(method, path, body) {
        calls.push({ method, path, body });
        return { flushed: true };
      },
    };

    await saveAgentMemory(client, {
      conversationId: "sess-1",
      messages: [],
      flush: true,
    });

    assert.deepEqual(calls[0].body, {
      conversationId: "sess-1",
      messages: [],
      flush: true,
    });
  });
});

describe("agent memory channel claim", () => {
  const messages = [{ role: "user", timestamp: 1710000000000, content: "hi" }];
  const capture = () => {
    const calls = [];
    const client = {
      async request(method, path, body) {
        calls.push(body);
        return { status: "accumulated", messageCount: body.messages.length, flushed: body.flush };
      },
    };
    return { calls, client };
  };

  test("saveAgentMemory forwards an explicit channel claim", async () => {
    const { calls, client } = capture();
    await saveAgentMemory(client, { conversationId: "sess-1", messages, channel: "hook" });
    assert.equal(calls[0].channel, "hook");
  });

  test("saveAgentMemory sends no channel field unless the caller claims one", async () => {
    // MCP save_turn and other unclaimed writers must stay channel-less: the
    // gate treats an unclaimed writer as trim-subject but never lets it
    // advance a watermark, and L1-2 must not count it as a hook.
    const { calls, client } = capture();
    await saveAgentMemory(client, { conversationId: "sess-1", messages });
    assert.equal(Object.hasOwn(calls[0], "channel"), false);
  });

  test("saveAgentMemory stamps the channel claim on every batch of a split upload", async () => {
    const { calls, client } = capture();
    const many = Array.from({ length: MAX_MESSAGES_PER_REQUEST + 1 }, (_, i) => ({
      role: "user",
      timestamp: 1710000000000 + i,
      content: `m${i}`,
    }));
    await saveAgentMemory(client, { conversationId: "sess-1", messages: many, channel: "hook" });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((body) => body.channel), ["hook", "hook"]);
  });
});

describe("agent memory logical turns", () => {
  const capture = () => {
    const calls = [];
    const client = {
      async request(method, path, body) {
        calls.push(body);
        return { status: "accumulated", messageCount: body.messages.length, flushed: body.flush };
      },
    };
    return { calls, client };
  };
  const user = (i) => ({ role: "user", timestamp: 1710000000000 + i, content: `m${i}` });

  test("saveAgentMemory forwards a caller-declared turn count on the last batch only", async () => {
    // The server adds `turns` to the L1-2 denominator. A split write must add
    // its turns once, on the batch whose success completes the write - a
    // leading batch that lands while the last one fails is a lost turn, not a
    // delivered one.
    const { calls, client } = capture();
    const many = Array.from({ length: MAX_MESSAGES_PER_REQUEST + 1 }, (_, i) => user(i));
    await saveAgentMemory(client, { conversationId: "sess-1", messages: many, turns: 1 });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((body) => body.turns), [0, 1]);
  });

  test("saveAgentMemory never derives a turn count from the messages", async () => {
    // A whole-session upload of 1002 user messages splits into 500/500/2. A
    // derived count would put turns=1002 on the last batch, which the
    // gateway caps at 500 - the session could never land. Only the caller
    // knows what a logical turn is; without a declaration nothing is sent.
    const { calls, client } = capture();
    const session = Array.from({ length: 2 * MAX_MESSAGES_PER_REQUEST + 2 }, (_, i) => user(i));
    await saveAgentMemory(client, { conversationId: "sess-1", messages: session });
    assert.equal(calls.length, 3);
    assert.ok(calls.every((body) => !Object.hasOwn(body, "turns")));
  });

  test("flushAgentMemory carries no turn count", async () => {
    const { calls, client } = capture();
    await flushAgentMemory(client, { conversationId: "sess-1", turns: 1 });
    assert.equal(Object.hasOwn(calls[0], "turns"), false, "a flush is not a write");
  });
});

describe("agent memory turn coordinates", () => {
  const capture = () => {
    const calls = [];
    const client = {
      async request(method, path, body) {
        calls.push(body);
        return { status: "accumulated", messageCount: body.messages.length, flushed: body.flush };
      },
    };
    return { calls, client };
  };
  const user = (i) => ({ role: "user", timestamp: 1710000000000 + i, content: `q${i}` });
  const asst = (i) => ({ role: "assistant", timestamp: 1710000000000 + i, content: `a${i}` });

  test("turnOrdinals: a user message opens a turn, leading context rides with turn 0", () => {
    assert.deepEqual(turnOrdinals([asst(0), user(1), asst(2), user(3), asst(4)]), [0, 0, 0, 1, 1]);
  });

  test("splitTurnAligned closes a forced tail before the next user message", () => {
    const slices = splitTurnAligned([user(0), asst(1), asst(2), user(3), asst(4)], 2);
    assert.deepEqual(slices.map((s) => s.map((m) => m.content)), [["q0", "a1"], ["a2"], ["q3", "a4"]]);
  });

  test("completedTurns claims a split turn once, on the tail that closes it", () => {
    const slices = [[user(0), asst(1)], [asst(2)], [user(3), asst(4)]];
    assert.deepEqual([0, 1, 2].map((i) => completedTurns(slices, i, 7)), [0, 1, 1]);
    // At turn 0 the first slice's leading non-user message is opening context.
    assert.equal(completedTurns([[asst(0), user(1), asst(2)]], 0, 0), 1);
    // Past turn 0 it is the tail of the previous upload's last turn.
    assert.equal(completedTurns([[asst(0), user(1), asst(2)]], 0, 4), 2);
    // An upload ending on a bare user message leaves that turn open.
    assert.equal(completedTurns([[user(0), asst(1), user(2)]], 0, 0), 1);
  });

  test("saveAgentMemory with baseTurn addresses each batch and derives completed turns", async () => {
    const { calls, client } = capture();
    // Three whole turns declared by the caller as one Stop, starting at turn 4.
    await saveAgentMemory(client, {
      conversationId: "sess-1",
      channel: "hook",
      turns: 1,
      baseTurn: 4,
      messages: [user(0), asst(1), user(2), asst(3), user(4), asst(5)],
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].baseTurn, 4);
    assert.equal(calls[0].turns, 3, "derived from the messages, not the caller's declaration");
    assert.equal(calls[0].channel, "hook");
  });

  test("saveAgentMemory with baseTurn splits turn-aligned and never claims an open turn early", async () => {
    const { calls, client } = capture();
    // Turn 9 alone is longer than a request; its head declares 0, its tail 1.
    const longTurn = [user(0), ...Array.from({ length: MAX_MESSAGES_PER_REQUEST }, (_, i) => asst(i + 1))];
    await saveAgentMemory(client, {
      conversationId: "sess-1",
      baseTurn: 9,
      messages: [...longTurn, user(900), asst(901)],
    });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((b) => b.baseTurn), [9, 9, 10]);
    assert.deepEqual(calls.map((b) => b.turns), [0, 1, 1]);
    assert.equal(calls[1].messages[0].role, "assistant", "the tail carries no user message");
    assert.equal(calls[2].messages[0].role, "user", "the next turn starts its own request");
  });

  test("saveAgentMemory without baseTurn keeps the legacy wire shape", async () => {
    const { calls, client } = capture();
    await saveAgentMemory(client, { conversationId: "sess-1", channel: "hook", turns: 1, messages: [user(0), asst(1)] });
    assert.equal(Object.hasOwn(calls[0], "baseTurn"), false);
    assert.equal(calls[0].turns, 1);
  });

  test("baseTurn preserves complete-turn priority instead of mechanically filling a request", async () => {
    const { calls, client } = capture();
    const messages = [user(0), asst(1), user(2), ...Array.from({ length: MAX_MESSAGES_PER_REQUEST - 2 }, (_, i) => asst(i + 3))];
    await saveAgentMemory(client, { conversationId: "sess-1", baseTurn: 6, messages });
    assert.deepEqual(calls.map((body) => body.messages.length), [2, MAX_MESSAGES_PER_REQUEST - 1]);
    assert.deepEqual(calls.map((body) => body.baseTurn), [6, 7]);
    assert.deepEqual(calls.map((body) => body.turns), [1, 1]);
    assert.deepEqual(calls.flatMap((body) => body.messages), messages);
  });
});

describe("agent memory keeps the turn of a message that is not the person's words", () => {
  test("sends a placeholder as an empty user message so turn positions do not move", async () => {
    const bodies = [];
    const client = { async request(_method, _path, body) { bodies.push(body); return {}; } };
    await saveAgentMemory(client, {
      conversationId: "placeholder",
      baseTurn: 4,
      flush: false,
      messages: [
        { role: "user", timestamp: 1, content: "", placeholder: true },
        { role: "assistant", timestamp: 2, content: "Background job done." },
        { role: "user", timestamp: 3, content: "" },
        { role: "user", timestamp: 4, content: "next request" },
      ],
    });
    assert.deepEqual(bodies[0].messages.map((m) => [m.role, m.content]), [
      ["user", ""],
      ["assistant", "Background job done."],
      ["user", "next request"],
    ]);
    assert.equal(bodies[0].baseTurn, 4);
    assert.ok(!Object.hasOwn(bodies[0].messages[0], "placeholder"));
  });
});
