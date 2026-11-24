import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveAgentMemory } from "@everme/agent-sdk";
import { claudeCodeAdapter } from "../hooks/scripts/lib/adapter.js";

test("declares a per-turn Stop boundary so batch writes claim the hook channel", () => {
  // Claude Code fires Stop once per turn and runs the delivery marker, so its
  // writes belong in L1-2's denominator. The SDK only claims the channel on
  // the batch path for adapters that say so.
  assert.equal(claudeCodeAdapter.turnBoundary, "stop");
});

test("fork capture excludes inherited records before checkpoints and turn coordinates", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "everme-claude-fork-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const transcriptPath = path.join(dir, "child.jsonl");
  const rows = [
    { sessionId: "parent", uuid: "parent-user", message: { role: "user", content: "parent task" } },
    { sessionId: "parent", uuid: "parent-answer", message: { role: "assistant", content: "parent done" } },
    { sessionId: "child", uuid: "child-user", message: { role: "user", content: "child task" } },
    { sessionId: "child", uuid: "child-call", message: { role: "assistant", content: [{ type: "tool_use", id: "call", name: "inspect", input: {} }] } },
    { sessionId: "child", uuid: "child-result", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "" }] } },
    { sessionId: "child", uuid: "child-answer", message: { role: "assistant", content: "child done", stop_reason: "end_turn" } },
  ];
  const write = () => writeFile(transcriptPath, [...rows.map((row, i) => ({ ...row, timestamp: 1788688800000 + i })), { type: "turn_duration" }].map(JSON.stringify).join("\n"));
  await write();
  const input = claudeCodeAdapter.normalizeInput({ session_id: "child", transcript_path: transcriptPath }, "Stop");
  let state = { initialized: false, uploadedCount: 0 };
  const checkpointStore = { read: async () => state };
  const [batch] = await claudeCodeAdapter.readStoreBatches(input, { checkpointStore });
  assert.equal(batch.baseTurn, 0);
  assert.equal(batch.checkpoint.uploadedCount, 4);
  assert.equal(batch.messages.length, 4);
  assert.equal(batch.messages[1].toolCalls[0].id, "call");
  assert.equal(batch.messages[2].toolCallId, "call");
  assert.equal(batch.messages[2].content, "");
  assert.deepEqual(await claudeCodeAdapter.readLastTurn(input), batch.messages);
  assert.equal(await claudeCodeAdapter.resolveTurnId(input), "child-answer");
  const writes = [];
  await saveAgentMemory({ request: async (_method, _path, body) => { writes.push(body); return {}; } }, { ...batch, channel: "hook", taskBatching: true });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].conversationId, "child");
  assert.equal(writes[0].baseTurn, 0);
  assert.equal(writes[0].messages.length, 4);
  state = { initialized: true, uploadedCount: batch.checkpoint.uploadedCount };
  assert.deepEqual(await claudeCodeAdapter.readStoreBatches(input, { checkpointStore }), []);
  rows.push(
    { sessionId: "child", uuid: "next-user", message: { role: "user", content: "next task" } },
    { sessionId: "child", uuid: "next-answer", message: { role: "assistant", content: "next done" } },
  );
  await write();
  const [next] = await claudeCodeAdapter.readStoreBatches(input, { checkpointStore });
  assert.equal(next.baseTurn, 1);
  assert.equal(next.messages.length, 2);
  assert.equal(next.checkpoint.uploadedCount, 6);
});

const lines = [
  { type: "user", timestamp: "2026-09-07T08:00:00.000Z", message: { role: "user", content: "q0" } },
  { type: "assistant", timestamp: "2026-09-07T08:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "a0" }] } },
  { type: "user", timestamp: "2026-09-07T08:00:02.000Z", message: { role: "user", content: "q1" } },
  { type: "assistant", timestamp: "2026-09-07T08:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "a1" }] } },
  { type: "user", timestamp: "2026-09-07T08:00:04.000Z", message: { role: "user", content: "q2" } },
  { type: "assistant", timestamp: "2026-09-07T08:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "a2" }] } },
];
async function transcript(t, rows = lines) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "everme-cc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const p = path.join(dir, "s.jsonl");
  await writeFile(p, rows.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}
const store = (state) => ({ async read() { return state; }, async commit() {} });

test("a cold-start tail is unpositioned and declares no completed turn", async (t) => {
  // No checkpoint yet on a multi-turn transcript (a resumed pre-existing
  // session): only the last turn is uploaded, and it must neither claim the
  // turns before it (baseTurn) nor be appended as turn 0 (turns).
  const [batch] = await claudeCodeAdapter.readStoreBatches(
    { sessionId: "s", transcriptPath: await transcript(t) },
    { checkpointStore: store({ initialized: false, uploadedCount: 0 }) },
  );
  assert.equal(batch.messages.length, 2);
  assert.equal(Object.hasOwn(batch, "baseTurn"), false);
  assert.equal(batch.turns, 0);
});

test("a checkpoint continuation is addressed by its absolute turn", async (t) => {
  const [batch] = await claudeCodeAdapter.readStoreBatches(
    { sessionId: "s", transcriptPath: await transcript(t) },
    { checkpointStore: store({ initialized: true, uploadedCount: 4 }) },
  );
  assert.equal(batch.messages.length, 2);
  assert.equal(batch.baseTurn, 2, "q2 opens turn 2");
  assert.equal(Object.hasOwn(batch, "turns"), false, "the runtime declares the Stop's turn");
});

test("a whole-transcript upload starts at turn 0", async (t) => {
  // A brand-new session's first Stop: the transcript IS the last turn, so the
  // upload covers everything before it and is addressed from turn 0.
  const [batch] = await claudeCodeAdapter.readStoreBatches(
    { sessionId: "s", transcriptPath: await transcript(t, lines.slice(0, 2)) },
    { checkpointStore: store({ initialized: false, uploadedCount: 0 }) },
  );
  assert.equal(batch.messages.length, 2);
  assert.equal(batch.baseTurn, 0);
  assert.equal(Object.hasOwn(batch, "turns"), false);
});

// An earlier Stop of this session died before its write reached the gateway
// (gateway or cloud down): those turns are this hook's own, so the next Stop
// uploads from turn 0 instead of dropping them as pre-install history.
test("a cold start after a failed Stop uploads the whole transcript", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "everme-claude-resume-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const transcriptPath = path.join(dir, "s.jsonl");
  const rows = [
    { type: "user", sessionId: "s", uuid: "u1", message: { role: "user", content: "first, sent while the gateway was down" } },
    { type: "assistant", sessionId: "s", uuid: "a1", message: { role: "assistant", content: "noted", stop_reason: "end_turn" } },
    { type: "user", sessionId: "s", uuid: "u2", message: { role: "user", content: "second" } },
    { type: "assistant", sessionId: "s", uuid: "a2", message: { role: "assistant", content: "done", stop_reason: "end_turn" } },
  ];
  await writeFile(transcriptPath, rows.map((row, i) => JSON.stringify({ ...row, timestamp: 1788688800000 + i })).join("\n"));
  const input = claudeCodeAdapter.normalizeInput({ session_id: "s", transcript_path: transcriptPath }, "Stop");
  const checkpointStore = { read: async () => ({ initialized: false, uploadedCount: 0 }) };

  const [tail] = await claudeCodeAdapter.readStoreBatches(input, { checkpointStore });
  assert.equal(tail.messages.length, 2, "a plain cold start still sends only the newest turn");
  const [all] = await claudeCodeAdapter.readStoreBatches(input, { checkpointStore, resumeFromStart: true });
  assert.equal(all.messages.length, 4);
  assert.equal(all.messages[0].content, "first, sent while the gateway was down");
  assert.equal(all.baseTurn, 0);
});
