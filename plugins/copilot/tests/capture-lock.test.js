import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { captureLockPath, withCaptureLock } from "../src/capture-lock.js";

describe("withCaptureLock", () => {
  test("runs captures of one session one after another", async () => {
    const sessionId = `lock-test-${process.pid}-serial`;
    const order = [];
    const capture = (name, ms) => withCaptureLock(sessionId, async () => {
      order.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(`${name}:end`);
    });
    await Promise.all([capture("agentStop", 120), capture("sessionEnd", 0)]);
    // Either capture may take the lock first; they must not interleave.
    const [first, second] = [order[0].split(":")[0], order[2].split(":")[0]];
    assert.notEqual(first, second);
    assert.deepEqual(order, [`${first}:start`, `${first}:end`, `${second}:start`, `${second}:end`]);
    assert.equal(existsSync(captureLockPath(sessionId)), false);
  });

  test("takes over a lock whose owner is gone", async () => {
    const sessionId = `lock-test-${process.pid}-stale`;
    await writeFile(captureLockPath(sessionId), "2147483646\n");
    let ran = false;
    await withCaptureLock(sessionId, async () => { ran = true; }, { waitMs: 200 });
    assert.equal(ran, true);
    assert.equal(existsSync(captureLockPath(sessionId)), false);
  });

  test("runs anyway once the wait ceiling passes", async () => {
    const sessionId = `lock-test-${process.pid}-busy`;
    await writeFile(captureLockPath(sessionId), `${process.pid}\n`);
    let ran = false;
    await withCaptureLock(sessionId, async () => { ran = true; }, { waitMs: 100 });
    assert.equal(ran, true);
    assert.equal(existsSync(captureLockPath(sessionId)), true, "a lock held by someone else is left alone");
    await rm(captureLockPath(sessionId), { force: true });
  });
});
