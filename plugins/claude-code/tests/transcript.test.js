import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { saveAgentMemory } from "@everme/agent-sdk";
import { extractTurns, extractAgentMessages, buildTranscriptMarkdown } from "../hooks/scripts/lib/transcript.js";
import { claudeCodeAdapter } from "../hooks/scripts/lib/adapter.js";

const cleanFixture = fileURLToPath(new URL("./fixtures/claude-clean-transcript.jsonl", import.meta.url));
const requestBlobFixture = fileURLToPath(new URL("./fixtures/claude-request-blob-transcript.jsonl", import.meta.url));

describe("transcript request snapshots", () => {
  test("api-request-blob records are not conversation turns", () => {
    const messages = extractAgentMessages(readFileSync(requestBlobFixture, "utf8").trim().split("\n"));

    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "tool", "assistant", "tool", "assistant"]);
    assert.equal(messages[0].content, "deploy the site");
    assert.deepEqual(messages.filter((m) => m.role === "tool").map((m) => m.toolCallId), ["toolu_blob_search", "toolu_blob_deploy"]);
    assert.equal(messages[5].content, "Deployed v42.");
  });

  test("the first Stop of a session with snapshots still lands the whole first turn", async () => {
    const [batch] = await claudeCodeAdapter.readStoreBatches({ sessionId: "claude-blob-session", transcriptPath: requestBlobFixture });

    assert.equal(batch.baseTurn, 0);
    assert.equal(batch.messages[0].content, "deploy the site");
    assert.equal(batch.messages.length, 6);
  });
});

describe("transcript native turn completion", () => {
  for (const reason of ["end_turn", "tool_use", "max_tokens", "unknown", null, undefined, true]) {
    test(`maps only native end_turn, not ${String(reason)}`, () => {
      const messages = extractAgentMessages([JSON.stringify({
        type: "assistant", timestamp: 1788688800000,
        message: { role: "assistant", content: "Done.", stop_reason: reason },
      })]);
      assert.equal(messages[0].turnComplete, reason === "end_turn" ? true : undefined);
    });
  }

  test("does not infer completion from flat fields or an empty final message", () => {
    const messages = extractAgentMessages([
      JSON.stringify({ role: "assistant", content: "Working.", stop_reason: "end_turn" }),
      JSON.stringify({ message: { role: "assistant", content: "", stop_reason: "end_turn" } }),
    ]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].turnComplete, undefined);
  });

  function turn(prefix, pairs) {
    const rows = [{ role: "assistant", content: "Inspecting." }];
    for (let i = 0; i < pairs; i++) {
      rows.push({ role: "assistant", content: [{ type: "tool_use", id: `${prefix}-${i}`, name: "Read", input: {} }], stop_reason: "tool_use" });
      rows.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `${prefix}-${i}`, content: "ok" }] });
    }
    rows.push({ role: "assistant", content: "Done.", stop_reason: "end_turn" });
    return rows;
  }

  for (const [name, rows, sizes] of [
    ["exact limit", [...turn("a", 248), ...turn("b", 0)], [500]],
    ["complete turns", [...turn("a", 248), ...turn("b", 2)], [498, 6]],
    ["oversized turn", turn("a", 250), [499, 3]],
  ]) {
    test(`batches ${name} without a user and preserves completion for gateway batching`, async () => {
      const lines = rows.map((message, i) => JSON.stringify({ message, timestamp: 1788688800000 + i }));
      const messages = extractAgentMessages(lines, { subagent: true });
      const requests = [];
      await saveAgentMemory({ request: async (_method, _path, body) => { requests.push(body); return {}; } }, {
        conversationId: "parent__child", messages, flush: false,
      });
      assert.deepEqual(requests.map(r => r.messages.length), sizes);
      assert.equal(requests.flatMap(r => r.messages).length, rows.length);
      for (const request of requests) {
        assert.deepEqual(request.messages.flatMap(m => m.toolCalls || []).map(c => c.id).sort(), request.messages.filter(m => m.role === "tool").map(m => m.toolCallId).sort());
        assert.ok(request.messages.every(m => m.role !== "user"));
        if (name !== "oversized turn") assert.equal(request.messages.at(-1).role, "assistant");
      }
      assert.deepEqual(requests.flatMap(r => r.messages).map(m => m.turnComplete), messages.map(m => m.turnComplete));
    });
  }
});

describe("transcript native tool names", () => {
  const call = (id, name, input = {}) => ({ type: "tool_use", id, name, input });
  const parse = (events, diagnostic = () => {}) => extractAgentMessages(events.map(e => JSON.stringify(e)), { diagnostic });
  for (const [label, name] of Object.entries({ missing: undefined, null: null, empty: "", blank: " \t", unicode: "\u3000", number: 42, boolean: false, object: { private: "secret-name" }, array: ["secret-name"] })) {
    test(`drops ${label} name and its result while preserving valid calls and text`, () => {
      const diagnostics = [];
      const messages = parse([
        { role: "assistant", content: [{ type: "text", text: "Working." }, call("bad", name), call("good", "unknown")] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "bad", content: "private-result" }, { type: "tool_result", tool_use_id: "good", content: "" }] },
        { role: "assistant", content: "Done." },
      ], line => diagnostics.push(line));
      assert.equal(messages.length, 3);
      assert.equal(messages[0].content, "Working.");
      assert.deepEqual(messages[0].toolCalls.map(c => [c.id, c.name]), [["good", "unknown"]]);
      assert.equal(messages[1].toolCallId, "good");
      assert.equal(messages[1].content, "");
      assert.equal(messages[2].content, "Done.");
      assert.equal(diagnostics.length, 1);
      assert.match(diagnostics[0], /invalid_tool_name dropped_calls=1 dropped_results=1/);
      assert.doesNotMatch(diagnostics[0], /secret-name|private-result/);
    });
  }
  test("preserves original valid names including unknown and surrounding spaces", () => {
    for (const name of ["Read", "unknown", " unknown "]) {
      const messages = parse([{ role: "assistant", content: [call("native", name)] }]);
      assert.equal(messages[0].toolCalls[0].name, name);
    }
  });
  test("classifies name before arguments and removes empty assistant and flat result", () => {
    const diagnostics = [];
    const messages = parse([
      { role: "tool", toolCallId: "bad", content: "result before call" },
      { role: "assistant", content: [call("bad", undefined, "bad arguments")] },
    ], line => diagnostics.push(line));
    assert.equal(messages.length, 0);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], /invalid_tool_name dropped_calls=1 dropped_results=1/);
  });
  test("does not guess result ownership when native IDs conflict", () => {
    const messages = parse([
      { role: "assistant", content: [call("duplicate", undefined), call("duplicate", "Read")] },
      { role: "tool", toolCallId: "duplicate", content: "ambiguous result" },
      { role: "tool", toolCallId: "orphan", content: "source orphan" },
    ]);
    assert.equal(messages.length, 3);
    assert.equal(messages[0].toolCalls.length, 1);
    assert.equal(messages[1].content, "ambiguous result");
    assert.equal(messages[2].content, "source orphan");
  });
  test("bounds per-reason aggregate diagnostics for invalid names and arguments", () => {
    const events = [];
    for (let i = 0; i < 1000; i++) events.push(
      { role: "assistant", content: [call(`name-${i}`, { private: "secret-name" }), call(`args-${i}`, "Read", "private-arguments")] },
      { role: "tool", toolCallId: `name-${i}`, content: "private-result" },
      { role: "tool", toolCallId: `args-${i}`, content: "private-result" },
    );
    const diagnostics = [];
    assert.equal(parse(events, line => diagnostics.push(line)).length, 0);
    assert.equal(diagnostics.length, 2);
    for (const line of diagnostics) {
      assert.match(line, /dropped_calls=1000 dropped_results=1000/);
      assert.ok(Buffer.byteLength(line) <= 1024);
      assert.doesNotMatch(line, /secret-name|private-arguments|private-result/);
    }
  });
});

describe("transcript tool arguments", () => {
  const parse = (events, diagnostics = []) => extractAgentMessages(events.map(event => JSON.stringify(event)), {
    diagnostic: line => diagnostics.push(line),
  });
  const call = (id, input) => ({ type: "tool_use", id, name: "Read", input });
  const result = (id, content = "") => ({ type: "tool_result", tool_use_id: id, content });

  for (const input of ["", " \t", "command: pwd", '{"path":', "undefined", "{private-secret}".repeat(1000)]) {
    test(`drops invalid argument pair (${input.length} characters) while retaining other content`, () => {
      const diagnostics = [];
      const messages = parse([
        { role: "assistant", content: [call("bad", input), { type: "text", text: "Explanation" }, call("good", { path: "a" })] },
        { role: "user", content: [result("good"), { type: "text", text: "Actual user" }, result("bad", "private-secret")] },
        { role: "assistant", content: "Done" },
      ], diagnostics);
      assert.equal(messages.length, 4);
      assert.equal(messages[0].content, "Explanation");
      assert.deepEqual(messages[0].toolCalls.map(c => c.id), ["good"]);
      assert.equal(messages[1].toolCallId, "good");
      assert.equal(messages[1].content, "");
      assert.equal(messages[2].content, "Actual user");
      assert.equal(messages[3].content, "Done");
      assert.equal(diagnostics.length, 1);
      assert.match(diagnostics[0], /invalid_tool_arguments.*dropped_calls=1 dropped_results=1/);
      assert.ok(Buffer.byteLength(diagnostics[0]) <= 1024);
      assert.doesNotMatch(diagnostics[0], /private-secret/);
    });
  }

  test("preserves valid argument encodings and non-JSON tool result text", () => {
    for (const input of [{ path: "a" }, '{ "path": "a" }', [], 0, false, "null", '"literal"', undefined, null]) {
      const messages = parse([
        { role: "assistant", content: [call("native", input)] },
        { role: "user", content: [result("native", "not JSON: normal output")] },
      ]);
      assert.equal(messages.length, 2);
      const expected = typeof input === "string" ? input : JSON.stringify(input ?? {});
      assert.equal(messages[0].toolCalls[0].arguments, expected);
      assert.equal(messages[1].content, "not JSON: normal output");
    }
  });

  test("drops empty assistant and its flat result without deleting standalone results", () => {
    const messages = parse([
      { role: "tool", toolCallId: "bad", content: "early source result" },
      { role: "assistant", content: [call("bad", "broken")] },
      { role: "tool", toolCallId: "standalone", content: "source orphan" },
    ]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].toolCallId, "standalone");
  });

  test("does not guess result ownership for conflicting native call IDs", () => {
    const messages = parse([
      { role: "assistant", content: [call("duplicate", "broken"), call("duplicate", {})] },
      { role: "user", content: [result("duplicate", "ambiguous source result")] },
    ]);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].toolCalls.length, 1);
    assert.equal(messages[0].toolCalls[0].arguments, "{}");
    assert.equal(messages[1].content, "ambiguous source result");
  });

  test("aggregates diagnostics for many invalid argument pairs", () => {
    const events = [];
    for (let i = 0; i < 1000; i++) events.push(
      { role: "assistant", content: [call(`native-${i}`, "private-secret")] },
      { role: "user", content: [result(`native-${i}`, "private-secret")] },
    );
    const diagnostics = [];
    assert.equal(parse(events, diagnostics).length, 0);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], /dropped_calls=1000 dropped_results=1000/);
    assert.ok(Buffer.byteLength(diagnostics[0]) <= 1024);
  });
});

describe("transcript native tool IDs", () => {
  test("drops empty assistant after removing an invalid tool block", () => {
    const lines = [JSON.stringify({ role: "assistant", content: [
      { type: "text", text: "" },
      { type: "tool_use", id: null, name: "Read", input: {} },
      { type: "text", text: "" },
    ] })];
    assert.equal(extractAgentMessages(lines).length, 0);
  });

  for (const [name, id] of Object.entries({ missing: undefined, null: null, empty: "", blank: " \t", number: 1, object: {}, array: [], boolean: true })) {
    test(`drops ${name} tool IDs without removing valid blocks or text`, () => {
      const diagnostics = [];
      const lines = [
        { role: "assistant", content: [{ type: "tool_use", id, name: "Read", input: {} }] },
        { role: "assistant", content: [
          { type: "text", text: "Actual explanation" },
          { type: "tool_use", id, name: "Read", input: {} },
          { type: "tool_use", id: "native-1", name: "Read", input: {} },
        ] },
        { role: "user", content: [
          { type: "text", text: "Actual request" },
          { type: "tool_result", tool_use_id: id, content: "private result sentinel" },
          { type: "tool_result", tool_use_id: "native-1", content: "" },
        ] },
        { role: "tool", toolCallId: id, content: "private result sentinel" },
      ].map(JSON.stringify);
      const messages = extractAgentMessages(lines, { diagnostic: line => diagnostics.push(line) });
      assert.deepEqual(messages.map(m => m.role), ["assistant", "tool", "user"]);
      assert.equal(messages[0].content, "Actual explanation");
      assert.deepEqual(messages[0].toolCalls.map(c => c.id), ["native-1"]);
      assert.equal(messages[1].toolCallId, "native-1");
      assert.equal(messages[1].content, "");
      assert.equal(messages[2].content, "Actual request");
      assert.equal(diagnostics.length, 1);
      assert.match(diagnostics[0], /dropped_invalid_call_id=2/);
      assert.match(diagnostics[0], /dropped_invalid_result_id=2/);
      assert.doesNotMatch(diagnostics[0], /sentinel|Actual|native-1/);
    });
  }

  test("preserves native IDs including compatibility fields and generated-looking values", () => {
    const diagnostics = [];
    const ids = ["claude_tool_123_0", "native-2", "native-3", "native-4"];
    const lines = [
      { role: "assistant", content: ids.map((id, index) => ({ type: "tool_use", ...(index ? { id: 1, tool_use_id: id } : { id }), name: "Read", input: {} })) },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: ids[0], content: "" },
        { type: "tool_result", tool_use_id: null, toolCallId: ids[1], content: "ok" },
        { type: "tool_result", tool_use_id: {}, tool_call_id: ids[2], content: "ok" },
      ] },
      { role: "tool", toolCallId: false, tool_call_id: ids[3], content: "ok" },
      { role: "tool", toolCallId: "native-unmatched", content: "source result" },
    ].map(JSON.stringify);
    const messages = extractAgentMessages(lines, { diagnostic: line => diagnostics.push(line) });
    assert.deepEqual(messages[0].toolCalls.map(c => c.id), ids);
    assert.deepEqual(messages.slice(1).map(m => m.toolCallId), [...ids, "native-unmatched"]);
    assert.deepEqual(diagnostics, []);
  });

  test("bounds aggregate diagnostics without including source fields", () => {
    const diagnostics = [];
    const lines = Array.from({ length: 2000 }, () => JSON.stringify({ role: "assistant", content: [{ type: "tool_use", id: { secret: "private sentinel" }, name: "private name", input: "private input" }] }));
    assert.equal(extractAgentMessages(lines, { diagnostic: line => diagnostics.push(line) }).length, 0);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], /dropped_invalid_call_id=2000/);
    assert.ok(diagnostics[0].length <= 1024);
    assert.doesNotMatch(diagnostics[0], /private|secret/);
  });
});

describe("transcript.extractTurns", () => {
  test("flattens user + assistant + tool events with hasToolCall", () => {
    const lines = [
      JSON.stringify({ role: "user", content: "Find the latest bug", timestamp: 1 }),
      JSON.stringify({
        role: "assistant",
        content: [
          { type: "text", text: "I'll search the repo." },
          { type: "tool_use", name: "grep", input: { pattern: "TODO" } },
        ],
        timestamp: 2,
      }),
      JSON.stringify({
        role: "tool",
        content: "matched 3 lines",
        timestamp: 3,
      }),
      JSON.stringify({
        role: "assistant",
        content: [{ type: "text", text: "Here are the matches." }],
        timestamp: 4,
      }),
    ];
    const turns = extractTurns(lines);
    assert.equal(turns.length, 4);
    assert.equal(turns[0].role, "user");
    assert.equal(turns[1].role, "assistant");
    assert.equal(turns[1].hasToolCall, true);
    assert.equal(turns[2].role, "tool");
    assert.equal(turns[3].role, "assistant");
    assert.equal(turns[3].hasToolCall, false);
  });

  test("skips malformed JSONL lines silently", () => {
    const lines = [
      "this is not json",
      JSON.stringify({ role: "user", content: "hi", timestamp: 1 }),
      "}{",
    ];
    const turns = extractTurns(lines);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].text, "hi");
  });

  test("buildTranscriptMarkdown emits front matter + role headers", () => {
    const turns = [
      { role: "user", text: "hello", ts: 1714478400000, hasToolCall: false },
    ];
    const md = buildTranscriptMarkdown(turns, {
      sessionId: "sess_x",
      agentId: "agt_test",
    });
    assert.match(md, /everme_runtime_version: 1/);
    assert.match(md, /agent_id: agt_test/);
    assert.match(md, /session_key: sess_x/);
    assert.match(md, /## user · /);
    assert.match(md, /hello/);
  });

  test("extractAgentMessages preserves assistant tool calls and tool results", () => {
    const lines = [
      JSON.stringify({ role: "user", content: "Find the latest bug", timestamp: 1 }),
      JSON.stringify({
        role: "assistant",
        content: [
          { type: "text", text: "I'll search the repo." },
          { type: "tool_use", id: "toolu_1", name: "grep", input: { pattern: "TODO" } },
        ],
        timestamp: 2,
      }),
      JSON.stringify({
        role: "tool",
        tool_use_id: "toolu_1",
        content: "matched 3 lines",
        timestamp: 3,
      }),
    ];

    const messages = extractAgentMessages(lines);
    assert.equal(messages.length, 3);
    assert.equal(messages[1].role, "assistant");
    assert.equal(messages[1].toolCalls[0].id, "toolu_1");
    assert.equal(messages[1].toolCalls[0].arguments, '{"pattern":"TODO"}');
    assert.equal(messages[2].role, "tool");
    assert.equal(messages[2].toolCallId, "toolu_1");
  });

  test("filters Claude metadata, UI records, and sidechains without dropping trusted assistant deltas", async () => {
    const lines = readFileSync(cleanFixture, "utf8").trim().split("\n");
    const messages = extractAgentMessages(lines);

    assert.equal(messages.length, 9);
    assert.equal(messages[0].content, "orphan assistant must not be imported");
    assert.equal(messages[1].content, "/review src/app.js");
    assert.equal(messages[2].toolCalls[0].id, "toolu_clean_1");
    assert.equal(messages[3].role, "tool");
    assert.equal(messages[3].toolCallId, "toolu_clean_1");
    assert.match(messages[5].content, /<system-reminder>/);
    assert.equal(messages[7].content, "请描述图中问题");
    assert.ok(messages.every((message) => !String(message.content || "").includes("internal")));
    assert.ok(messages.every((message) => !String(message.content || "").includes("model changed")));

    assert.deepEqual(
      await claudeCodeAdapter.readLastTurn({ transcriptPath: cleanFixture }),
      messages.slice(7),
    );
  });

  test("subagent mode drops its task user while preserving assistant/tool execution", () => {
    const lines = [
      { type: "user", isSidechain: true, agentId: "child", message: { role: "user", content: "task wrapper" } },
      { type: "assistant", isSidechain: true, agentId: "child", message: { role: "assistant", content: [{ type: "tool_use", id: "call", name: "Read", input: { file: "a" } }] } },
      { type: "user", isSidechain: true, agentId: "child", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "ok" }] } },
      { type: "assistant", isSidechain: true, agentId: "child", message: { role: "assistant", content: "child answer" } },
    ].map((row) => JSON.stringify(row));

    const messages = extractAgentMessages(lines, { subagent: true });
    assert.deepEqual(messages.map((message) => message.role), ["assistant", "tool", "assistant"]);
    assert.equal(messages[0].toolCalls[0].name, "Read");
    assert.equal(messages[1].toolCallId, "call");
    assert.equal(messages[2].content, "child answer");
  });
});

describe("transcript records without a time", () => {
  test("leave the timestamp to the SDK so a resend reuses the first fallback", async () => {
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: "rename it" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Renamed.", stop_reason: "end_turn" } }),
    ];
    const messages = extractAgentMessages(lines);
    assert.deepEqual(messages.map((m) => m.timestamp), [undefined, undefined]);

    const bodies = [];
    const client = { async request(_m, _p, body) { bodies.push(body); return { status: "accepted" }; } };
    await saveAgentMemory(client, { conversationId: "cc-no-time", messages: extractAgentMessages(lines), flush: false });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await saveAgentMemory(client, { conversationId: "cc-no-time", messages: extractAgentMessages(lines), flush: false });
    assert.deepEqual(bodies[1].messages.map((m) => m.timestamp), bodies[0].messages.map((m) => m.timestamp));
  });
});

describe("transcript user role carries only what the person wrote", () => {
  const user = (content, extra = {}) => JSON.stringify({ type: "user", message: { role: "user", content }, timestamp: "2026-11-18T08:00:00Z", ...extra });
  const userRows = (lines) => extractAgentMessages(lines).filter((m) => m.role === "user").map((m) => (m.placeholder ? "<placeholder>" : m.content));

  test("keeps human input, records without origin and origins it cannot attribute to a machine", () => {
    assert.deepEqual(userRows([
      user("ship it", { origin: { kind: "human" } }),
      user("older record"),
      user("from my phone", { origin: { kind: "channel", server: "telegram" } }),
      user("run this", { origin: { kind: "remote", transport: "uds" } }),
      user("future kind", { origin: { kind: "something-new" } }),
    ]), ["ship it", "older record", "from my phone", "run this", "future kind"]);
  });

  test("turns machine-made records earlier releases uploaded into placeholders", () => {
    assert.deepEqual(userRows([
      user("<scheduled-task name=\"nightly\" file=\"/x/SKILL.md\">\nThis is an automated run of a scheduled task.\n</scheduled-task>", { origin: { kind: "task-notification", subkind: "scheduled-trigger" } }),
      user("continue with the plan", { origin: { kind: "auto-continuation" } }),
      user("delete segment 7", { origin: { kind: "peer" } }),
      user("report back", { origin: { kind: "coordinator" } }),
      user("observe", { origin: { kind: "observer-activity" } }),
      user("This session is being continued from a previous conversation that ran out of context.", { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
      user([{ type: "text", text: "[Request interrupted by user]" }]),
      user("[Request interrupted by user for tool use]\n"),
      user("<agent-message from=\"Chief\" id=\"m1\">\nDelete lines 385-517.\n</agent-message>"),
    ]), Array(9).fill("<placeholder>"));
  });

  test("still drops what earlier releases already dropped, so no turn is added", () => {
    assert.deepEqual(userRows([
      user("<task-notification>\n<task-id>b1</task-id>\n</task-notification>", { origin: { kind: "task-notification" } }),
      user("<system-reminder>ctx</system-reminder>"),
    ]), []);
  });

  test("keeps an agent-message the host marks as typed by the person", () => {
    const text = "<agent-message from=\"me\">\nquoting a relay\n</agent-message>";
    assert.deepEqual(userRows([user(text, { origin: { kind: "human" } })]), [text]);
  });

  test("unwraps orchestrator and IDE wrappers around the person's words", () => {
    assert.deepEqual(userRows([
      user("\n<system_instruction>\nThe user has linked directories to this workspace.\n- /Users/u/app\n</system_instruction>\n\n修一下登录", { origin: { kind: "human" } }),
      user("<timestamp>Tuesday, Nov 18, 2026, 4:05 PM (UTC+8)</timestamp>\n<user_query>\n帮我看看\n</user_query>"),
      user("<openbot_saved_memories>\nSaved\n</openbot_saved_memories>\nnext?"),
      user("<system_instruction>\nThis workspace is running in a VM in the cloud.\n</system_instruction>"),
      user("<hc>t2 reviewer exited (code 0). Read: hc read t2</hc>"),
    ]), ["修一下登录", "帮我看看", "next?", "<placeholder>", "<placeholder>"]);
  });

  test("keeps tool results beside a placeholder marker", () => {
    const line = JSON.stringify({ type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: "partial output" },
      { type: "text", text: "[Request interrupted by user for tool use]" },
    ] } });
    const messages = extractAgentMessages([line]);
    assert.deepEqual(messages.map((m) => [m.role, m.toolCallId ?? null, m.content]), [["tool", "toolu_1", "partial output"], ["user", null, ""]]);
  });
});
