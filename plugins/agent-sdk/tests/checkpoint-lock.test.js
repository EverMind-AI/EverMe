import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test, { afterEach, describe } from "node:test";
import { fileURLToPath } from "node:url";

import { createTranscriptCheckpointStore } from "../src/hooks/state.js";

const sdkDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function stateDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "everme-ckpt-"));
  dirs.push(dir);
  return dir;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("transcript checkpoint under concurrency", () => {
  // The reason the section must QUEUE and not skip: a second Stop for one
  // session is not necessarily the same delta. It is just as likely to be the
  // next turn the user already finished. A waiter that gives up leaves those
  // rows uncommitted, and if no further Stop arrives they are gone.
  test("a second turn is still committed when the holder outlasts the wait budget", async () => {
    const store = createTranscriptCheckpointStore({ stateDir: await stateDir() });
    const order = [];

    const holder = store.withSession("sess", async () => {
      const state = await store.read("sess");
      order.push("holder-read");
      // Deliberately longer than any wait budget a caller might pick.
      await sleep(600);
      await store.commit("sess", 1, {
        nativeMessageIds: [...(state.nativeMessageIds || []), "turn-1"],
      });
      order.push("holder-commit");
    });

    await sleep(30);

    const second = store.withSession("sess", async () => {
      // Reads AFTER the holder committed, so it sees turn-1 and adds turn-2.
      const state = await store.read("sess");
      order.push("second-read");
      await store.commit("sess", 2, {
        nativeMessageIds: [...(state.nativeMessageIds || []), "turn-2"],
      });
      order.push("second-commit");
    });

    await Promise.all([holder, second]);

    // The point is the DATA, not who held the lock: turn-2 must be committed.
    assert.deepEqual(order, ["holder-read", "holder-commit", "second-read", "second-commit"]);
    const final = await store.read("sess");
    assert.deepEqual([...final.nativeMessageIds].sort(), ["turn-1", "turn-2"]);
  });

  test("the delta a queued waiter computes excludes what the holder just committed", async () => {
    const store = createTranscriptCheckpointStore({ stateDir: await stateDir() });
    const uploads = [];

    // Both see the same three rows; the holder takes the first two, so the
    // waiter must upload only the third rather than resending everything.
    const rows = ["a", "b", "c"];
    const worker = (take) =>
      store.withSession("sess", async () => {
        const state = await store.read("sess");
        const seen = new Set(state.nativeMessageIds || []);
        const missing = rows.filter((id) => !seen.has(id)).slice(0, take);
        if (!missing.length) return;
        uploads.push(missing);
        await sleep(120);
        await store.commit("sess", missing.length, { nativeMessageIds: [...seen, ...missing] });
      });

    const first = worker(2);
    await sleep(20);
    await Promise.all([first, worker(3)]);

    assert.deepEqual(uploads, [["a", "b"], ["c"]]);
  });

  test("two separate PROCESSES serialize, and neither turn is lost", async () => {
    const dir = await stateDir();
    const script = path.join(dir, "worker.mjs");
    await writeFile(
      script,
      `
import { createTranscriptCheckpointStore } from ${JSON.stringify(path.join(sdkDir, "src/hooks/state.js"))};
const [, , stateDir, id, holdMs] = process.argv;
const store = createTranscriptCheckpointStore({ stateDir });
const ran = await store.withSession("sess", async () => {
  const state = await store.read("sess");
  const seen = state.nativeMessageIds || [];
  await new Promise((r) => setTimeout(r, Number(holdMs)));
  await store.commit("sess", seen.length + 1, { nativeMessageIds: [...seen, id] });
});
process.stdout.write(JSON.stringify({ id, ran }));
`,
    );

    const run = (id, holdMs) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, dir, id, String(holdMs)], { stdio: "pipe" });
        let out = "";
        child.stdout.setEncoding("utf8").on("data", (c) => {
          out += c;
        });
        child.on("error", reject);
        child.on("close", () => resolve(JSON.parse(out || "{}")));
      });

    // The holder outlasts the wait budget, in a real second OS process - the
    // earlier version of this test used two promises in one process, which an
    // in-memory mutex would also have passed.
    const [a, b] = await Promise.all([run("turn-1", 900), (await sleep(80), run("turn-2", 0))]);

    assert.equal(a.ran, true, "the first process should hold the lock");
    const final = JSON.parse(
      await readFile(path.join(dir, "sess.transcript.json"), "utf8"),
    );
    assert.deepEqual([...final.nativeMessageIds].sort(), ["turn-1", "turn-2"]);
  });

  test("a lock whose owner process is gone is reaped, not waited on", async () => {
    const dir = await stateDir();
    const store = createTranscriptCheckpointStore({ stateDir: dir });
    // A pid that cannot be running. Its mtime is NOW, so an mtime-only
    // staleness rule would make this wait out the full timeout.
    await writeFile(path.join(dir, "sess.transcript.json.lock"), "2147483646\n");

    const started = Date.now();
    let ran = false;
    const ok = await store.withSession("sess", async () => {
      ran = true;
    });

    assert.equal(ok, true);
    assert.equal(ran, true);
    assert.ok(Date.now() - started < 1500, "a dead owner must not cost a full wait");
  });

  test("a live but slow holder does NOT have its lock stolen", async () => {
    const store = createTranscriptCheckpointStore({ stateDir: await stateDir() });
    const inside = [];

    const holder = store.withSession("sess", async () => {
      inside.push("enter");
      await sleep(400);
      inside.push("leave");
    });
    await sleep(40);
    await store.withSession("sess", async () => {
      inside.push("second");
    });
    await holder;

    // "second" between enter and leave would mean the lock was stolen from a
    // process that is very much alive.
    assert.deepEqual(inside, ["enter", "leave", "second"]);
  });

  // The fallback that must NOT exist: running the section unlocked once the
  // ceiling expires. The holder read an earlier snapshot, so its commit would
  // overwrite the waiter's - a silent lost update, worse than the skip this
  // replaced. Expiry therefore throws and leaves the rows for the next Stop.
  test("expiring against a wedged holder throws instead of running unlocked", async () => {
    const store = createTranscriptCheckpointStore({ stateDir: await stateDir(), lockWaitMs: 40 });
    let waiterRan = false;

    const holder = store.withSession("sess", async () => {
      await store.commit("sess", 1, { nativeMessageIds: ["turn-1"] });
      await sleep(400);
    });
    await sleep(30);

    await assert.rejects(
      store.withSession("sess", async () => {
        waiterRan = true;
        await store.commit("sess", 9, { nativeMessageIds: ["clobbered"] });
      }),
      /everme_checkpoint_lock_timeout/,
    );
    await holder;

    assert.equal(waiterRan, false, "the section must not run without the lock");
    const final = await store.read("sess");
    assert.deepEqual(final.nativeMessageIds, ["turn-1"], "the holder's commit survives");
  });

  test("a throwing critical section still releases the lock", async () => {
    const store = createTranscriptCheckpointStore({ stateDir: await stateDir() });

    await assert.rejects(
      store.withSession("sess", async () => {
        throw new Error("upload blew up");
      }),
      /upload blew up/,
    );

    let ran = false;
    await store.withSession("sess", async () => {
      ran = true;
    });
    assert.equal(ran, true);
  });

  test("different sessions are not serialized against each other", async () => {
    const store = createTranscriptCheckpointStore({ stateDir: await stateDir() });
    let concurrent = 0;
    let peak = 0;

    const hold = (id) =>
      store.withSession(id, async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await sleep(60);
        concurrent -= 1;
      });

    await Promise.all([hold("one"), hold("two")]);

    assert.equal(peak, 2);
  });
});
