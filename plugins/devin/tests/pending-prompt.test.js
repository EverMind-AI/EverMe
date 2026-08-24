import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stashPrompt, takePrompt } from "../src/pending-prompt.js";

function withStateDir(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "everme-devin-state-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// The prompt and the answer reach us as two separate hook events, in two
// separate processes. Without carrying the prompt across, every stored
// turn would be an answer with no question.
describe("Devin pending prompt", () => {
  test("a stashed prompt is returned to the response that follows it", withStateDir(async (dir) => {
    await stashPrompt("traj-1", "how many lines", { stateDir: dir });
    assert.equal(await takePrompt("traj-1", { stateDir: dir }), "how many lines");
  }));

  test("taking it consumes it, so one prompt cannot label two answers", withStateDir(async (dir) => {
    await stashPrompt("traj-1", "once", { stateDir: dir });
    assert.equal(await takePrompt("traj-1", { stateDir: dir }), "once");
    assert.equal(await takePrompt("traj-1", { stateDir: dir }), "");
  }));

  test("trajectories do not borrow each other's prompts", withStateDir(async (dir) => {
    await stashPrompt("traj-1", "first", { stateDir: dir });
    await stashPrompt("traj-2", "second", { stateDir: dir });
    assert.equal(await takePrompt("traj-2", { stateDir: dir }), "second");
    assert.equal(await takePrompt("traj-1", { stateDir: dir }), "first");
  }));

  test("a prompt is user content, so it is not left world-readable", withStateDir(async (dir) => {
    await stashPrompt("traj-1", "private question", { stateDir: dir });
    const entry = path.join(dir, "devin-prompt-traj-1.json");
    assert.equal(statSync(entry).mode & 0o777, 0o600);
  }));

  test("an id with path separators cannot escape the state directory", withStateDir(async (dir) => {
    await stashPrompt("../../escape", "x", { stateDir: dir });
    assert.equal(await takePrompt("../../escape", { stateDir: dir }), "x");
    assert.equal(statSync(dir).isDirectory(), true);
  }));

  test("nothing stashed reads as nothing, not as a crash", withStateDir(async (dir) => {
    assert.equal(await takePrompt("never-seen", { stateDir: dir }), "");
  }));

  test("a missing trajectory id is not tracked at all", withStateDir(async (dir) => {
    await stashPrompt("", "orphan", { stateDir: dir });
    assert.equal(await takePrompt("", { stateDir: dir }), "");
  }));
});
