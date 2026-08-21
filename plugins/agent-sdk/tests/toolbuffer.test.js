import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createToolEventBuffer } from "../src/hooks/toolbuffer.js";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function newBuffer() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "everme-toolbuffer-"));
  tempDirs.push(dir);
  return { buffer: createToolEventBuffer({ stateDir: dir }), dir };
}

describe("tool event buffer", () => {
  test("drain returns appended events in order and clears the file", async () => {
    const { buffer, dir } = await newBuffer();
    await buffer.append("session-a", { name: "shell", input: { command: "ls" }, output: "a.js" });
    await buffer.append("session-a", { name: "read_file", input: { path: "a.js" }, output: "body" });

    const events = await buffer.drain("session-a");
    assert.equal(events.length, 2);
    assert.equal(events[0].name, "shell");
    assert.equal(events[1].name, "read_file");
    assert.ok(events[0].ts <= events[1].ts, "events must carry monotonic timestamps");

    assert.deepEqual(await buffer.drain("session-a"), []);
    const leftovers = (await readdir(dir)).filter((name) => name.includes("session-a"));
    assert.deepEqual(leftovers, [], "drain must remove the buffer file");
  });

  test("drain keeps events for the requested generation and lenient ones without a generation", async () => {
    const { buffer } = await newBuffer();
    await buffer.append("session-b", { name: "stale", generationId: "gen-old" });
    await buffer.append("session-b", { name: "current", generationId: "gen-new" });
    await buffer.append("session-b", { name: "unstamped" });

    const events = await buffer.drain("session-b", { generationId: "gen-new" });
    assert.deepEqual(events.map((event) => event.name), ["current", "unstamped"]);
  });

  test("drain of an unknown session returns an empty list", async () => {
    const { buffer } = await newBuffer();
    assert.deepEqual(await buffer.drain("never-seen"), []);
  });

  test("append caps the buffer file instead of growing without bound", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "everme-toolbuffer-"));
    tempDirs.push(dir);
    const buffer = createToolEventBuffer({ stateDir: dir, maxBytes: 2048 });
    const bulk = "x".repeat(500);
    for (let i = 0; i < 12; i += 1) {
      await buffer.append("session-c", { name: `tool_${i}`, output: bulk });
    }
    const events = await buffer.drain("session-c");
    assert.ok(events.length < 12, "the cap must drop appends past the byte limit");
    assert.ok(events.length > 0, "events under the cap must survive");
  });

  test("buffer files are private to the user", async () => {
    const { buffer, dir } = await newBuffer();
    await buffer.append("session-d", { name: "shell" });
    const [file] = (await readdir(dir)).filter((name) => name.includes("session-d"));
    const info = await stat(path.join(dir, file));
    assert.equal(info.mode & 0o777, 0o600);
  });
});
