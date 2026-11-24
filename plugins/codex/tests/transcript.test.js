import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTranscriptCheckpointStore, saveAgentMemory } from "@everme/agent-sdk";
import { readCodexStoreBatches } from "../src/store-batches.js";
import { readCanonicalTranscript, readLastTurn } from "../src/transcript.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "codex-rollout.jsonl");
const cleanFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "codex-clean-rollout.jsonl");
const subagentFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "codex-subagent-rollout.jsonl");
const regressionFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "codex-regressions-rollout.jsonl");
const regressionExpected = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "codex-regressions.expected.json");
const emptyFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "empty-rollout.jsonl");

describe("Codex rollout parser", () => {
  test("goal mapping requires explicit provenance and preserves turn metadata", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "everme-goal-"));
    try {
      const rollout = path.join(dir, "goal.jsonl");
      const prefix = '<codex_internal_context source="goal">';
      const close = "</codex_internal_context>";
      for (const [content, expected] of [
        [`${prefix}The objective below is user-provided data.<objective>inspect deployment</objective>${close}`, "inspect deployment"],
        [`${prefix}The objective below is user-provided data.<objective>inspect deployment</objective>${close}\nmore input`, "inspect deployment\n\nmore input"],
        [`${prefix}<objective>untrusted objective</objective>${close}`, null],
        [`${prefix}The objective below is user-provided data.${close}`, null],
      ]) {
        await writeFile(rollout, [
          JSON.stringify({ type: "session_meta", payload: { history_mode: "paginated" } }),
          JSON.stringify({ type: "turn_context", payload: { turn_id: "goal-turn" } }),
          JSON.stringify({ type: "response_item", timestamp: "2026-09-07T00:00:00Z", payload: { type: "message", role: "user", content } }),
        ].join("\n"));
        const messages = await readCanonicalTranscript(rollout);
        assert.equal(messages.length, expected ? 1 : 0);
        if (expected) {
          assert.equal(messages[0].content, expected);
          assert.equal(messages[0].role, "user");
          assert.equal(messages[0].timestamp, Date.parse("2026-09-07T00:00:00Z"));
          assert.equal(messages[0].turnId, "goal-turn");
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("drops native records without IDs and preserves every supplied ID", async () => {
    const source = path.join(path.dirname(fixture), "codex-native-id-rollout.jsonl");
    const diagnostics = [];
    const messages = await readCanonicalTranscript(source, { diagnostic: (line) => diagnostics.push(line) });
    assert.equal(messages.length, 6);
    const calls = messages.flatMap((message) => message.toolCalls || []);
    assert.deepEqual(calls.map((call) => call.id), [
      "known-custom", "codex_generated_tool_3",
    ]);
    assert.equal(new Set(calls.map((call) => call.id)).size, calls.length);
    assert.deepEqual(messages.filter((message) => message.role === "tool").map((message) => message.toolCallId), [
      "real-unmatched", "codex_generated_tool_3",
    ]);
    assert.match(diagnostics[0], /dropped_missing_call_id=5/);
    assert.match(diagnostics[0], /dropped_missing_result_id=5/);
    assert.deepEqual(await readCanonicalTranscript(source), messages);
    const requests = [];
    await saveAgentMemory({ async request(method, path, body) { requests.push(body); return {}; } }, {
      conversationId: "native-id-fixture", messages,
    });
    assert.equal(requests[0].messages.length, 6);
    assert.equal(requests[0].messages[3].toolCalls[0].id, requests[0].messages[4].toolCallId);
  });

  test("rejects absent, blank, and non-string native IDs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "everme-codex-invalid-ids-"));
    try {
      const rollout = path.join(dir, "rollout.jsonl");
      const payloads = [undefined, null, "", "  ", 1, {}, []].flatMap((call_id) => [
        { type: "function_call", name: "shell", arguments: "{}", call_id },
        { type: "custom_tool_call", name: "exec", input: "pwd", call_id },
        { type: "function_call_output", output: "original result", call_id },
        { type: "custom_tool_call_output", output: "", call_id },
      ]);
      await writeFile(rollout, payloads.map((payload) => JSON.stringify({ type: "response_item", payload })).join("\n"));
      const diagnostics = [];
      assert.deepEqual(await readCanonicalTranscript(rollout, { diagnostic: (line) => diagnostics.push(line) }), []);
      assert.match(diagnostics[0], /dropped_missing_call_id=14/);
      assert.match(diagnostics[0], /dropped_missing_result_id=14/);
      assert.doesNotMatch(diagnostics[0], /original result/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("normalizes raw arguments and keeps boundary metadata off the wire", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "everme-codex-contract-"));
    try {
      const rollout = path.join(dir, "rollout.jsonl");
      const item = (payload) => JSON.stringify({ type: "response_item", payload });
      await writeFile(rollout, [
        JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-a" } }),
        item({ type: "function_call", name: "shell", call_id: "call-a", arguments: "command: pwd" }),
        item({ type: "function_call_output", call_id: "call-a", output: "" }),
        item({ type: "message", role: "assistant", phase: "commentary", content: "Working" }),
        item({ type: "message", role: "assistant", phase: "final_answer", content: "Done" }),
        JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-b" } }),
        item({ type: "message", role: "assistant", content: "Finished" }),
        JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
        item({ type: "web_search_call", status: "completed", action: { query: "example" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
      ].join("\n"));
      const messages = await readCanonicalTranscript(rollout);
      assert.deepEqual(JSON.parse(messages[0].toolCalls[0].arguments), { input: "command: pwd" });
      assert.equal(messages[0].turnId, "turn-a");
      assert.equal(messages[2].turnComplete, false);
      assert.equal(messages[3].turnComplete, true);
      assert.equal(messages[4].turnComplete, true);
      assert.equal(messages[4].turnId, "turn-b");
      assert.equal(messages[5].turnComplete, false);
      assert.doesNotMatch(JSON.stringify(messages), /turnComplete|turnId/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports bounded reason counts without logging source content", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "everme-codex-diagnostics-"));
    try {
      const rollout = path.join(dir, "rollout.jsonl");
      const secret = "private source text ".repeat(1000);
      await writeFile(rollout, [
        "invalid JSON",
        JSON.stringify({ type: "response_item", payload: { type: secret, content: secret } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer", content: secret } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: "[external_agent_tool_result]unmatched[/external_agent_tool_result]" } }),
      ].join("\n"));
      const diagnostics = [];
      await readCanonicalTranscript(rollout, { diagnostic: (line) => diagnostics.push(line) });
      assert.equal(diagnostics.length, 1);
      assert.ok(diagnostics[0].length < 512);
      assert.match(diagnostics[0], /malformed_json=1/);
      assert.match(diagnostics[0], /unknown_payload=1/);
      assert.match(diagnostics[0], /system_message=1/);
      assert.match(diagnostics[0], /dropped_legacy_tool_without_id=1/);
      assert.doesNotMatch(diagnostics[0], /private source|unmatched/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports incomplete and conflicting tool records without guessing repairs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "everme-codex-pairs-"));
    try {
      const rollout = path.join(dir, "rollout.jsonl");
      const payloads = [
        { type: "function_call", name: "shell", call_id: "duplicate", arguments: "{}" },
        { type: "function_call", name: "shell", call_id: "duplicate", arguments: "{}" },
        { type: "function_call_output", call_id: "duplicate", output: "" },
        { type: "function_call_output", call_id: "orphan", output: "original result" },
      ];
      await writeFile(rollout, payloads.map((payload) => JSON.stringify({ type: "response_item", payload })).join("\n"));
      const diagnostics = [];
      const messages = await readCanonicalTranscript(rollout, { diagnostic: (line) => diagnostics.push(line) });
      assert.equal(messages.length, payloads.length);
      assert.match(diagnostics[0], /duplicate_call_id=1/);
      assert.match(diagnostics[0], /orphan_result=1/);
      assert.match(diagnostics[0], /missing_result=1/);
      assert.doesNotMatch(diagnostics[0], /original result/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("matches the shared cold-start/realtime regression golden", async () => {
    const expected = JSON.parse(await readFile(regressionExpected, "utf8"));
    assert.deepEqual(await readCanonicalTranscript(regressionFixture), expected);
    assert.deepEqual(await readLastTurn(regressionFixture), expected.slice(-3));
  });

  test("streams only the latest user turn and preserves the tool trajectory", async () => {
    const messages = await readLastTurn(fixture);
    const fallbackTimestamp = Math.trunc((await stat(fixture)).mtimeMs) + 11;

    assert.deepEqual(messages, [
      {
        role: "user",
        timestamp: 1749001003000,
        content: "inspect config.json",
      },
      {
        role: "assistant",
        timestamp: 1749001005000,
        toolCalls: [{
          id: "call_latest",
          type: "function",
          name: "read_file",
          arguments: '{"path":"config.json"}',
        }],
      },
      {
        role: "tool",
        timestamp: 1749001006000,
        toolCallId: "call_latest",
        content: '{"enabled":true}',
      },
      {
        role: "assistant",
        timestamp: 1749001007000,
        content: "Memory is enabled.",
      },
      {
        // Real Codex rollouts write ISO-8601 timestamps — must parse to
        // epoch milliseconds, not fall through as unparseable.
        role: "assistant",
        timestamp: 1749001008000,
        content: "Config check complete.",
      },
      {
        role: "assistant",
        timestamp: fallbackTimestamp,
        content: "Untimed trailing note.",
      },
    ]);
  });

  test("uses the transcript mtime fallback before the SDK upload", async () => {
    const bodies = [];
    const client = {
      async request(method, requestPath, body) {
        bodies.push(body);
        return { flushed: false };
      },
    };
    const fallbackTimestamp = Math.trunc((await stat(fixture)).mtimeMs) + 11;

    await saveAgentMemory(client, {
      conversationId: "codex-session",
      messages: await readLastTurn(fixture),
      flush: false,
    });

    const wire = bodies[0].messages;
    assert.equal(wire[4].timestamp, 1749001008000, "ISO timestamp ships as parsed epoch-ms");
    assert.equal(wire[5].timestamp, fallbackTimestamp,
      "missing timestamps use the same deterministic fallback as cold-start import");
  });

  test("canonicalizes paginated context and keeps every tool family", async () => {
    const messages = await readCanonicalTranscript(cleanFixture);

    assert.equal(messages.length, 10);
    assert.equal(messages[0].content, "agent activity before the first user");
    assert.equal(messages[1].content, "/inspect config.json");
    assert.deepEqual(messages[2].toolCalls, [{
      id: "call_exec",
      type: "function",
      name: "exec",
      arguments: '{"input":"cat config.json"}',
    }]);
    assert.deepEqual(messages[3], {
      role: "tool",
      timestamp: 1749002006000,
      toolCallId: "call_exec",
      content: "enabled=true",
    });
    assert.match(messages[5].content, /<app-context>/, "a user discussing a tag must survive");
    assert.match(messages[5].content, /# AGENTS\.md instructions/,
      "a user discussing AGENTS.md instructions must survive");
    assert.equal(messages[7].content, "token=[redacted]");
    assert.equal(messages[8].toolCalls, undefined);
    assert.deepEqual(JSON.parse(messages[8].content), {
      type: "web_search_call", action: { type: "search", query: "codex rollout schema" },
    });
    assert.ok(messages.every((message) => !String(message.content || "").includes("internal")));
    assert.ok(messages.every((message) => !String(message.content || "").includes("model changed")));

    assert.deepEqual(await readLastTurn(cleanFixture), messages.slice(5),
      "synthetic UI records must not reset the latest real user boundary");
  });

  test("uploads empty results and standalone search records without fabrication", async () => {
    const source = path.join(path.dirname(fixture), "codex-empty-tools-rollout.jsonl");
    const messages = await readCanonicalTranscript(source);
    const bodies = [];
    await saveAgentMemory({
      async request(method, requestPath, body) {
        bodies.push(body);
        return { flushed: false };
      },
    }, { conversationId: "empty-tools", messages, flush: false });

    assert.equal(bodies.length, 1);
    const wire = bodies[0].messages;
    assert.equal(wire.length, 9);
    const calls = wire.flatMap((message) => message.toolCalls || []);
    const results = wire.filter((message) => message.role === "tool");
    assert.equal(calls.length, 2);
    assert.equal(results.length, 2);
    assert.deepEqual(results.map((message) => message.toolCallId), calls.map((call) => call.id));
    assert.ok(results.every((message) => message.content === ""));
    for (const [index, expected] of [
      [5, { type: "web_search_call", status: "completed", action: { type: "search", query: "中文查询" } }],
      [6, { type: "web_search_call", status: "failed", action: { type: "open_page", url: "https://example.com/?token=[redacted]" } }],
      [7, { type: "web_search_call" }],
    ]) {
      assert.equal(wire[index].role, "assistant");
      assert.equal(wire[index].toolCalls, undefined);
      assert.equal(wire[index].toolCallId, undefined);
      assert.deepEqual(JSON.parse(wire[index].content), expected);
    }
    assert.equal(wire[8].content, "Finished checking the recorded actions.");
  });

  test("uses legacy user provenance and drops ID-less external tools", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "everme-codex-legacy-"));
    try {
      const rollout = path.join(dir, "rollout.jsonl");
      await writeFile(rollout, [
        JSON.stringify({ type: "session_meta", payload: { history_mode: "legacy", thread_source: "user" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "injected context" }] } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "real question" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "real question" }] } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "[external_agent_tool_call: Bash]\ncommand: pwd\n[/external_agent_tool_call]" }] } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "[external_agent_tool_result]\n/repo\n[/external_agent_tool_result]" }] } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "The repository is /repo." }] } }),
      ].join("\n"));

      const messages = await readCanonicalTranscript(rollout);
      assert.equal(messages.length, 2);
      assert.equal(messages[0].content, "real question");
      assert.equal(messages[1].content, "The repository is /repo.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips subagent trajectories without a real user", async () => {
    const diagnostics = [];
    assert.deepEqual(await readCanonicalTranscript(subagentFixture, { diagnostic: (line) => diagnostics.push(line) }), []);
    assert.deepEqual(await readLastTurn(subagentFixture), []);
    assert.match(diagnostics[0], /subagent_without_user=1/);
  });

  test("keeps outer subagent identity across nested fork metadata", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "everme-codex-mixed-"));
    try {
      const rollout = path.join(dir, "rollout.jsonl");
      await writeFile(rollout, [
        JSON.stringify({ type: "session_meta", payload: { history_mode: "paginated", thread_source: "subagent", parent_thread_id: "parent" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "forked parent context" }] } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "internal answer" }] } }),
        JSON.stringify({ type: "session_meta", payload: { history_mode: "paginated", thread_source: "user", parent_thread_id: null } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "real root question" }] } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "visible root answer" }] } }),
      ].join("\n"));

      assert.deepEqual(await readCanonicalTranscript(rollout), []);
      assert.deepEqual(await readLastTurn(rollout), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("long native outputs stay complete while ID-less legacy outputs are dropped", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "everme-codex-transcript-"));
    try {
      const rollout = path.join(dir, "rollout.jsonl");
      for (const size of [8000, 8001, 16001]) {
        const output = "\u59cb" + "\u6d4b".repeat(size - 2) + "\u7ec8";
        await writeFile(rollout, [
          JSON.stringify({ type: "session_meta", payload: { history_mode: "paginated", thread_source: "user" } }),
          JSON.stringify({ timestamp: 1749001000000, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] } }),
          JSON.stringify({ timestamp: 1749001001000, type: "response_item", payload: { type: "function_call", name: "shell", call_id: "call_1", arguments: "{}" } }),
          JSON.stringify({ timestamp: 1749001002000, type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output } }),
          JSON.stringify({ timestamp: 1749001003000, type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "call_2", input: "run()" } }),
          JSON.stringify({ timestamp: 1749001004000, type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_2", output: [{ type: "input_text", text: output }] } }),
          JSON.stringify({ timestamp: 1749001005000, type: "response_item", payload: { type: "message", role: "assistant", content: "[external_agent_tool_call: Bash]\n{}\n[/external_agent_tool_call]" } }),
          JSON.stringify({ timestamp: 1749001006000, type: "response_item", payload: { type: "message", role: "assistant", content: `[external_agent_tool_result]\n${output}\n[/external_agent_tool_result]` } }),
          JSON.stringify({ timestamp: 1749001007000, type: "response_item", payload: { type: "function_call", name: "shell", call_id: "call_3", arguments: "{}" } }),
          JSON.stringify({ timestamp: 1749001008000, type: "response_item", payload: { type: "function_call_output", call_id: "call_3", output: output + " emk_1234567890123456" } }),
        ].join("\n"));

        const messages = await readLastTurn(rollout);
        const results = messages.filter((m) => m.role === "tool");
        assert.equal(results.length, 3);
        for (const result of results.slice(0, 2)) assert.equal(result.content, output);
        assert.equal(results[2].content, output + " [redacted]");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns an empty delta when no user message exists", async () => {
    assert.deepEqual(await readLastTurn(emptyFixture), []);
  });

  // An earlier Stop of this session died before its write reached the
  // gateway: those turns are this hook's own, so the next Stop uploads the
  // root from turn 0 instead of only its newest turn.
  test("root Stop after a failed Stop uploads the whole transcript", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "everme-codex-resume-"));
    try {
      const rootPath = path.join(dir, "root.jsonl");
      await writeFile(rootPath, [
        JSON.stringify({ type: "session_meta", payload: { id: "root", history_mode: "paginated", thread_source: "user" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "lost turn" }] } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "lost answer" }] } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "new turn" }] } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "new answer" }] } }),
      ].join("\n"));
      const checkpointStore = createTranscriptCheckpointStore({ stateDir: path.join(dir, "state") });
      const [batch] = await readCodexStoreBatches({ sessionId: "root", transcriptPath: rootPath }, { checkpointStore, resumeFromStart: true });
      assert.deepEqual(batch.messages.map((message) => message.content), ["lost turn", "lost answer", "new turn", "new answer"]);
      assert.equal(batch.baseTurn, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("root Stop skips userless children and checkpoints assistant-only growth", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "everme-codex-batches-"));
    try {
      const rootPath = path.join(dir, "root.jsonl");
      const childPath = path.join(dir, "child.jsonl");
      const rootLines = [
        JSON.stringify({ type: "session_meta", payload: { id: "root", history_mode: "paginated", thread_source: "user" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "old turn" }] } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "old answer" }] } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "new turn" }] } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "new answer" }] } }),
      ];
      await writeFile(rootPath, rootLines.join("\n"));
      await writeFile(childPath, [
        JSON.stringify({ type: "session_meta", payload: { id: "child", history_mode: "paginated", thread_source: "subagent", parent_thread_id: "root" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "task wrapper" }] } }),
        JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "call", input: "pwd" } }),
        JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call", output: "/repo" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "child answer" }] } }),
        JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
      ].join("\n"));
      const checkpointStore = createTranscriptCheckpointStore({ stateDir: path.join(dir, "state") });
      const input = { sessionId: "root", transcriptPath: rootPath };

      const first = await readCodexStoreBatches(input, { checkpointStore });
      assert.deepEqual(first.map((batch) => batch.conversationId), ["root"]);
      assert.deepEqual(first[0].messages.map((message) => message.content), ["new turn", "new answer"]);
      for (const batch of first) {
        await checkpointStore.commit(batch.checkpoint.stateId, batch.checkpoint.uploadedCount);
      }

      rootLines.push(JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "late assistant delta" }] },
      }));
      await writeFile(rootPath, rootLines.join("\n"));
      const second = await readCodexStoreBatches(input, { checkpointStore });
      assert.equal(second.length, 1);
      assert.equal(second[0].conversationId, "root");
      assert.deepEqual(second[0].messages.map((message) => message.content), ["late assistant delta"]);
      await checkpointStore.commit(second[0].checkpoint.stateId, second[0].checkpoint.uploadedCount);
      assert.deepEqual(await readCodexStoreBatches(input, { checkpointStore }), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Codex user role carries only what the person wrote", () => {
  const userRows = async (texts) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "everme-codex-human-"));
    try {
      const rollout = path.join(dir, "rollout.jsonl");
      await writeFile(rollout, [
        JSON.stringify({ type: "session_meta", payload: { history_mode: "paginated" } }),
        ...texts.map((text, i) => JSON.stringify({ type: "response_item", timestamp: `2026-11-18T08:00:0${i}Z`, payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } })),
      ].join("\n"));
      return (await readCanonicalTranscript(rollout)).filter((m) => m.role === "user").map((m) => (m.placeholder ? "<placeholder>" : m.content));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  test("keeps the request after the attachment list the desktop app writes", async () => {
    const text = "\n# Files mentioned by the user:\n\n## plan.md: /Users/u/Downloads/plan.md\n\n## My request for Codex:\n参考这个方案给出技术方案\n";
    assert.deepEqual(await userRows([text]), ["参考这个方案给出技术方案"]);
  });

  test("drops the in-app browser state among the attachments", async () => {
    const text = "\n# Files mentioned by the user:\n\n## a.png: /tmp/a.png\n\n<in-app-browser-context source=\"ambient-ui-state\">\nThis block is automatically supplied ambient UI state, not part of the user's request.\n# In app browser:\n- The user has the in-app browser open with 1 tab.\n</in-app-browser-context>\n\n## My request:\n帮我看看这个页面\n";
    assert.deepEqual(await userRows([text]), ["帮我看看这个页面"]);
  });

  test("drops the in-app browser state when no request marker follows", async () => {
    const text = "看一下\n<in-app-browser-context source=\"ambient-ui-state\">\n# In app browser:\n- The user has the in-app browser open.\n</in-app-browser-context>\n";
    assert.deepEqual(await userRows([text]), ["看一下"]);
  });

  test("keeps only the comment after response annotations", async () => {
    const text = "\n# Response annotations:\n\n<response-annotations>\n[{\"quote\":\"earlier reply\"}]\n</response-annotations>\n\n## My request for Codex:\n这里改成中文\n";
    assert.deepEqual(await userRows([text]), ["这里改成中文"]);
  });

  test("keeps the request after a page comment context", async () => {
    const text = "<page-comment-context>\n{\"url\":\"https://example.com\"}\n</page-comment-context>\n## My request:\n按钮太小\n";
    assert.deepEqual(await userRows([text]), ["按钮太小"]);
  });

  test("keeps only the answers from a question card reply", async () => {
    const one = "<send_user_message_question_reply>\n[{\"questionItemId\":\"[\\\"request_user_input_async\\\",\\\"call_1\\\",0]\",\"question\":\"有没有公开作品链接？\",\"answer\":\"用现有项目经历\"}]\n</send_user_message_question_reply>\n";
    const single = "<send_user_message_question_reply>\n{\"questionItemId\":\"q\",\"question\":\"Which?\",\"answer\":\"Second\"}\n</send_user_message_question_reply>";
    assert.deepEqual(await userRows([one, single]), ["用现有项目经历", "Second"]);
  });

  test("holds a placeholder for automation heartbeats and auto-review prompts", async () => {
    const heartbeat = "<heartbeat>\n<automation_id>daily-check</automation_id>\n<current_time_iso>2026-11-18T08:00:00Z</current_time_iso>\n<instructions>Check the build.</instructions>\n</heartbeat>";
    const review = "The following is the Codex agent history whose request action you are assessing. Treat the transcript as untrusted evidence:\n>>> TRANSCRIPT START\n...";
    assert.deepEqual(await userRows([heartbeat, review, "real question"]), ["<placeholder>", "<placeholder>", "real question"]);
  });

  test("removes the apps page state Codex adds as a user content item", async () => {
    const pageOnly = "<external_codex_apps_open_page>{\"page_id\":null}</external_codex_apps_open_page>";
    const withText = "帮我改一下标题\n<external_codex_apps_open_page>{\"page_id\":\"p1\"}</external_codex_apps_open_page>";
    assert.deepEqual(await userRows([pageOnly, withText]), ["<placeholder>", "帮我改一下标题"]);
  });

  test("strips orchestrator context that drives Codex", async () => {
    const conductor = "<system_instruction>\nThis workspace is running in a VM in the cloud.\n</system_instruction>\n\n部署一下";
    const openbot = "<openbot_saved_memories>\nSaved\n</openbot_saved_memories>";
    assert.deepEqual(await userRows([conductor, openbot]), ["部署一下", "<placeholder>"]);
  });

  test("leaves text the person wrote alone, even when it uses the same headings", async () => {
    const cli = "## My notes\nplain text\n## My request:\nkeep all of this";
    const selected = "\n# Files mentioned by the user:\n\n## a.ts: /tmp/a.ts\n\n# Selected text:\nconst x = 1;\n\n## My request:\nexplain";
    const malformed = "<send_user_message_question_reply>\nnot json\n</send_user_message_question_reply>";
    assert.deepEqual(await userRows([cli, selected, malformed]), [cli, selected.trim(), malformed]);
  });
});
