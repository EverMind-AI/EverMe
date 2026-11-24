import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { readEvents, extractMessages, resolveTurnKey, lastTurn, effectiveEvents } from "../src/transcript.js";

// Built from schemas/session-events.schema.json of @github/copilot 1.0.104
// for the cases a live session rarely produces: two user turns, a tool round trip, an
// ephemeral delta, an autopilot continuation, a skill-injected prompt,
// sub-agent events, a rewound exchange, parallel calls with one failure, and
// a user-requested tool run.
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures", "copilot-events.jsonl");
// Captured from Copilot CLI 1.0.104 on 2026-10-27 (`copilot -p`, then
// `--resume -p`), with the system prompt, usage records, reasoning, memory
// text and local paths redacted. Turn 1 runs `ls`; turn 2 has recall injected
// into transformedContent and two parallel `view` calls, one of them failing.
const LIVE_FIXTURE = path.join(here, "fixtures", "copilot-cli-session.jsonl");

const lines = (events) => events.map((event) => JSON.stringify(event));

describe("copilot events reader", () => {
  it("reads both user turns with paired tool calls and final replies", async () => {
    const messages = extractMessages(await readEvents(FIXTURE));
    assert.deepEqual(messages.map((m) => m.role), [
      "user", "assistant", "tool", "assistant",
      "user", "assistant", "tool", "tool", "assistant",
    ]);
    assert.equal(messages[0].content, "Remember that my favorite language is Rust, then list the files here.");
    assert.deepEqual(messages[1].toolCalls, [{ id: "call_ls", name: "bash", arguments: "{\"command\":\"ls\",\"description\":\"List files\"}" }]);
    assert.equal(messages[2].toolCallId, "call_ls");
    assert.equal(messages[3].turnComplete, true);
    assert.equal(messages[1].turnComplete, undefined);
    assert.equal(messages[7].content, "File not found: missing.txt");
    assert.equal(messages[8].turnComplete, true);
  });

  it("uses the displayed text, not the model-facing transformed content", async () => {
    const [first] = extractMessages(await readEvents(FIXTURE));
    assert.doesNotMatch(first.content, /current_datetime/);
  });

  it("drops a leading recall block we injected ourselves", async () => {
    const messages = extractMessages(await readEvents(FIXTURE));
    assert.equal(messages[4].content, "Read both files at once.");
  });

  it("skips autopilot continuations, skill prompts, sub-agent events and rewound events", async () => {
    const text = JSON.stringify(extractMessages(await readEvents(FIXTURE)));
    for (const absent of ["Continue with the plan.", "pdf skill", "Sub-agent notes.", "sub output", "rewound", "user ran this"]) {
      assert.ok(!text.includes(absent), absent);
    }
  });

  it("keeps a string argument as is and serializes an object argument once", async () => {
    const messages = extractMessages(await readEvents(FIXTURE));
    assert.deepEqual(messages[5].toolCalls.map((call) => call.arguments), ["{\"path\":\"a.txt\"}", "{\"path\":\"missing.txt\"}"]);
  });

  it("removes every event from the rewind point when no event list is given", () => {
    const events = [
      { id: "a", type: "user.message", data: { content: "keep" } },
      { id: "b", type: "user.message", data: { content: "drop" } },
      { id: "c", type: "assistant.message", data: { messageId: "x", content: "drop too" } },
      { id: "d", type: "session.snapshot_rewind", data: { upToEventId: "b", eventsRemoved: 2 } },
      { id: "e", type: "user.message", data: { content: "after" } },
    ];
    assert.deepEqual(effectiveEvents(lines(events)).map((event) => event.id), ["a", "e"]);
  });

  it("removes only the listed events when the rewind names them", () => {
    const events = [
      { id: "a", type: "user.message", data: { content: "removed" } },
      { id: "b", type: "assistant.message", data: { messageId: "x", content: "kept: background agent interleaved" } },
      { id: "c", type: "session.snapshot_rewind", data: { upToEventId: "a", eventIds: ["a"], eventsRemoved: 1 } },
    ];
    assert.deepEqual(effectiveEvents(lines(events)).map((event) => event.id), ["b"]);
  });

  it("does not mark an unfinished turn complete", () => {
    const events = [
      { id: "a", type: "user.message", data: { content: "go" } },
      { id: "b", type: "assistant.message", data: { messageId: "x", content: "", toolRequests: [{ toolCallId: "c1", name: "bash", arguments: {} }] } },
    ];
    const messages = extractMessages(lines(events));
    assert.equal(messages.at(-1).turnComplete, undefined);
  });

  it("keys a turn by the last conversation event and slices the last turn", async () => {
    const raw = await readEvents(FIXTURE);
    assert.equal(resolveTurnKey(raw), "e-22");
    const turn = lastTurn(extractMessages(raw));
    assert.equal(turn[0].content, "Read both files at once.");
    assert.equal(turn.length, 5);
  });

  it("survives a torn trailing line and a missing file", async () => {
    const raw = await readEvents(FIXTURE);
    assert.equal(extractMessages([...raw, "{\"id\":\"torn"]).length, 9);
    assert.deepEqual(await readEvents(path.join(here, "fixtures", "missing.jsonl")), []);
  });
});

describe("copilot events reader on a live session", () => {
  it("reads both turns with paired calls and final replies", async () => {
    const messages = extractMessages(await readEvents(LIVE_FIXTURE));
    assert.deepEqual(messages.map((m) => m.role), [
      "user", "assistant", "tool", "assistant",
      "user", "assistant", "tool", "tool", "assistant",
    ]);
    assert.match(messages[0].content, /^Remember: my team's on-call database is CockroachDB\./);
    assert.equal(messages[1].toolCalls[0].name, "bash");
    assert.equal(messages[2].toolCallId, messages[1].toolCalls[0].id);
    assert.equal(messages[3].turnComplete, true);
    assert.deepEqual(messages[5].toolCalls.map((call) => call.name), ["view", "view"]);
    const calls = new Set(messages[5].toolCalls.map((call) => call.id));
    assert.ok(calls.has(messages[6].toolCallId) && calls.has(messages[7].toolCallId));
    assert.equal(messages[6].content, "Path does not exist");
    assert.equal(messages[8].turnComplete, true);
  });

  it("keeps the injected recall out of the user text", async () => {
    const raw = await readEvents(LIVE_FIXTURE);
    assert.ok(raw.some((line) => line.includes("<everme_recall>")), "the live transcript carries the recall");
    const text = JSON.stringify(extractMessages(raw));
    assert.doesNotMatch(text, /everme_recall|everme_profile|current_datetime/);
  });

  it("slices the newest turn", async () => {
    const turn = lastTurn(extractMessages(await readEvents(LIVE_FIXTURE)));
    assert.match(turn[0].content, /^Read notes\.txt and missing\.txt/);
    assert.equal(turn.length, 5);
  });
});

describe("events without a time", () => {
  it("leave the timestamp to the SDK instead of the read time", () => {
    const messages = extractMessages(lines([{ id: "a", type: "user.message", data: { content: "hello" } }]));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].timestamp, undefined);
  });
});
