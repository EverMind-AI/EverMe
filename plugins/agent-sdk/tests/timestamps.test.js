import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { saveAgentMemory } from "../src/agent-memory.js";
import {
  createMemoryTimestampLedger,
  createTimestampLedger,
  fallbackKeys,
  resolveFallbackTimestamps,
} from "../src/timestamps.js";

const run = promisify(execFile);
const SDK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function recordingClient() {
  const bodies = [];
  return {
    bodies,
    async request(_method, _path, body) {
      bodies.push(body);
      return { status: "accepted" };
    },
  };
}

const turn = () => [
  { role: "user", content: "rename the config key" },
  { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "edit", arguments: { path: "a.yaml" } }] },
  { role: "toolResult", toolCallId: "call_1", content: "done" },
  { role: "assistant", content: "Renamed." },
];

async function tempStateDir() {
  return mkdtemp(path.join(os.tmpdir(), "everme-ts-"));
}

test("a resend of the same turn carries the timestamps of the first send", async () => {
  const ledger = createTimestampLedger({ stateDir: await tempStateDir() });
  const client = recordingClient();
  await saveAgentMemory(client, { conversationId: "c1", messages: turn(), flush: false, timestampLedger: ledger });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await saveAgentMemory(client, { conversationId: "c1", messages: turn(), flush: false, timestampLedger: ledger });
  const [first, second] = client.bodies.map((body) => body.messages.map((m) => m.timestamp));
  assert.deepEqual(second, first);
  assert.equal(first.length, 4);
});

test("timestamps stay strictly increasing within a turn", async () => {
  const ledger = createTimestampLedger({ stateDir: await tempStateDir() });
  const client = recordingClient();
  await saveAgentMemory(client, { conversationId: "c2", messages: turn(), flush: false, timestampLedger: ledger });
  const stamps = client.bodies[0].messages.map((m) => m.timestamp);
  for (let i = 1; i < stamps.length; i += 1) assert.ok(stamps[i] > stamps[i - 1], `${stamps}`);
});

test("host timestamps pass through unchanged and anchor the fallbacks after them", async () => {
  const ledger = createTimestampLedger({ stateDir: await tempStateDir() });
  const client = recordingClient();
  const future = Date.now() + 60_000;
  const messages = [
    { role: "user", content: "hi", timestamp: "2026-10-28T03:55:36.000Z" },
    { role: "assistant", content: "hello", timestamp: future },
    { role: "assistant", content: "anything else?" },
  ];
  await saveAgentMemory(client, { conversationId: "c3", messages, flush: false, timestampLedger: ledger });
  const stamps = client.bodies[0].messages.map((m) => m.timestamp);
  assert.equal(stamps[0], Date.parse("2026-10-28T03:55:36.000Z"));
  assert.equal(stamps[1], future);
  assert.ok(stamps[2] > future);
});

test("a send whose messages all carry host timestamps never touches the ledger", async () => {
  const ledger = {
    async withConversation() {
      throw new Error("ledger must not be used");
    },
  };
  const out = await resolveFallbackTimestamps({
    conversationId: "c4",
    messages: [{ role: "user", content: "a", timestamp: 1_793_000_000_000 }],
    ledger,
  });
  assert.deepEqual(out, [undefined]);
});

test("a recovered batch that also carries the next turn keeps the first turn's timestamps", async () => {
  const ledger = createTimestampLedger({ stateDir: await tempStateDir() });
  const client = recordingClient();
  await saveAgentMemory(client, { conversationId: "c5", messages: turn(), flush: false, timestampLedger: ledger });
  const next = [{ role: "user", content: "and the docs" }, { role: "assistant", content: "Updated." }];
  await new Promise((resolve) => setTimeout(resolve, 5));
  await saveAgentMemory(client, { conversationId: "c5", messages: [...turn(), ...next], flush: false, timestampLedger: ledger });
  const first = client.bodies[0].messages.map((m) => m.timestamp);
  const second = client.bodies[1].messages.map((m) => m.timestamp);
  assert.deepEqual(second.slice(0, 4), first);
  assert.ok(second[4] > first[3]);
});

test("the same text in a different turn gets its own timestamp", () => {
  const keys = fallbackKeys("c6", [
    { role: "user", content: "continue" },
    { role: "assistant", content: "Step one." },
    { role: "user", content: "continue" },
    { role: "assistant", content: "Step two." },
  ]);
  assert.notEqual(keys[0], keys[2]);
  assert.equal(new Set(keys).size, 4);
});

test("an adapter-supplied nativeId keys the message by itself", () => {
  const [alone] = fallbackKeys("c7", [{ role: "user", content: "x", nativeId: "rec-9" }]);
  const withHistory = fallbackKeys("c7", [{ role: "assistant", content: "y" }, { role: "user", content: "x", nativeId: "rec-9" }]);
  assert.equal(alone, "id:rec-9");
  assert.equal(withHistory[1], "id:rec-9");
});

test("without a ledger the process ledger still keeps resends stable", async () => {
  const client = recordingClient();
  await saveAgentMemory(client, { conversationId: "c8", messages: turn(), flush: false });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await saveAgentMemory(client, { conversationId: "c8", messages: turn(), flush: false });
  assert.deepEqual(
    client.bodies[1].messages.map((m) => m.timestamp),
    client.bodies[0].messages.map((m) => m.timestamp),
  );
});

test("a ledger that cannot be locked degrades to fresh fallbacks instead of failing the write", async () => {
  const client = recordingClient();
  const warnings = [];
  const ledger = { async withConversation() { throw new Error("everme_timestamp_ledger_lock_timeout"); } };
  const res = await saveAgentMemory(
    client,
    { conversationId: "c9", messages: turn(), flush: false, timestampLedger: ledger },
    { info() {}, warn: (line) => warnings.push(line) },
  );
  assert.equal(res.status, "accepted");
  assert.equal(client.bodies[0].messages.length, 4);
  assert.match(warnings.join("\n"), /stage=timestamps result=degraded/);
});

test("a second process resends the turn with the same timestamps", async () => {
  const stateDir = await tempStateDir();
  const script = `
    import { saveAgentMemory, createTimestampLedger } from ${JSON.stringify(path.join(SDK, "index.js"))};
    const bodies = [];
    const client = { async request(_m, _p, body) { bodies.push(body); return { status: "accepted" }; } };
    const messages = ${JSON.stringify(turn())};
    await saveAgentMemory(client, {
      conversationId: "cross", messages, flush: false,
      timestampLedger: createTimestampLedger({ stateDir: ${JSON.stringify(stateDir)} }),
    });
    process.stdout.write(JSON.stringify(bodies[0].messages.map((m) => m.timestamp)));
  `;
  const first = JSON.parse((await run(process.execPath, ["--input-type=module", "-e", script])).stdout);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = JSON.parse((await run(process.execPath, ["--input-type=module", "-e", script])).stdout);
  assert.deepEqual(second, first);
  const files = await readdir(path.join(stateDir, "timestamps"));
  assert.equal(files.filter((name) => name.endsWith(".json")).length, 1);
});

test("the file ledger drops entries past their age and caps its size", async () => {
  let now = 1_000_000;
  const stateDir = await tempStateDir();
  const ledger = createTimestampLedger({ stateDir, maxAgeMs: 100, maxEntries: 3, clock: () => now });
  await ledger.withConversation("c10", (entries) => {
    for (let i = 0; i < 5; i += 1) entries.set(`k${i}`, i);
  });
  let seen;
  await ledger.withConversation("c10", (entries) => { seen = [...entries.keys()]; });
  assert.equal(seen.length, 3);
  now += 1_000;
  await ledger.withConversation("c10", (entries) => entries.set("fresh", 9));
  await ledger.withConversation("c10", (entries) => { seen = [...entries.keys()]; });
  assert.deepEqual(seen, ["fresh"]);
});

test("the memory ledger is bounded per conversation", async () => {
  const ledger = createMemoryTimestampLedger({ maxEntries: 2, maxConversations: 1 });
  await ledger.withConversation("a", (entries) => { entries.set("x", 1); entries.set("y", 2); entries.set("z", 3); });
  let size;
  await ledger.withConversation("a", (entries) => { size = entries.size; });
  assert.equal(size, 2);
  await ledger.withConversation("b", () => {});
  await ledger.withConversation("a", (entries) => { size = entries.size; });
  assert.equal(size, 0);
});
