/**
 * Agent-skill recall: score threshold, what a rendered skill line carries,
 * and the local body cache the id points at.
 *
 * The three are one mechanism. The renderer prints an id instead of a body
 * because the body was written to disk; the cache holds exactly the rows the
 * renderer kept, so an id in the prompt always resolves and a row below the
 * threshold never leaves a file behind.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildMemoryPrompt, filterSkillsByScore, SKILL_MIN_SCORE } from "../src/prompt.js";
import { createSkillContentCache } from "../src/hooks/skill-cache.js";
import { searchMemory } from "../src/search.js";

function skill(overrides = {}) {
  return {
    id: "6a98d9504ff33830c399cf66",
    name: "Security and compliance review",
    description: "How to scope and run a review before a release",
    content: "## Steps\n1. Scope the review\n2. Check the diff",
    relevanceScore: 0.99,
    ...overrides,
  };
}

describe("skill score threshold", () => {
  test("the floor is 0.1 and sits inside the empty band between 0.045 and 0.945", () => {
    assert.equal(SKILL_MIN_SCORE, 0.1);
  });

  test("a skill scored above the floor is rendered", () => {
    const out = buildMemoryPrompt({ agentMemory: { skills: [skill({ relevanceScore: 0.11 })] } }, { skillFetch: true });
    assert.match(out, /### Agent skills/);
    assert.match(out, /Security and compliance review/);
  });

  test("a skill scored below the floor is not rendered at all", () => {
    const out = buildMemoryPrompt({ agentMemory: { skills: [skill({ relevanceScore: 0.0999 })] } }, { skillFetch: true });
    assert.equal(out, "", "a below-floor skill must not even open an Agent skills section");
  });

  test("a skill scored exactly at the floor is rendered", () => {
    // The boundary is inclusive on purpose: 0.1 is the middle of an empty
    // band, so a row landing exactly on it is not a real case — but an
    // exclusive comparison here and an inclusive one in the cache filter
    // would drop a body whose id still reached the prompt.
    const out = buildMemoryPrompt({ agentMemory: { skills: [skill({ relevanceScore: SKILL_MIN_SCORE })] } }, { skillFetch: true });
    assert.match(out, /Security and compliance review/);
  });

  test("a skill with no score at all still passes — field-absent defence, not policy", () => {
    const rows = filterSkillsByScore([skill({ relevanceScore: undefined })]);
    assert.equal(rows.length, 1);
  });

  test("the real measured distribution keeps one skill out of six", () => {
    // Scores observed on a live agent for the query "security compliance
    // review": one direct hit, five unrelated.
    const scores = [0.989496648311615, 0.0013337897835299373, 0.001193779637105763,
      0.00030155415879562497, 0.00022955966414883733, 0.0001063726595020853];
    const rows = filterSkillsByScore(scores.map((s, i) => skill({ id: `id${i}`, relevanceScore: s })));
    assert.equal(rows.length, 1);
  });
});

describe("skill rendering", () => {
  test("a skill line carries the id so the body can be fetched by it", () => {
    // skillFetch is the host capability that makes an id redeemable; the id
    // shape only exists under it. The gated-off shape is covered in
    // skill-gate.test.js.
    const out = buildMemoryPrompt({ agentMemory: { skills: [skill()] } }, { skillFetch: true });
    assert.match(out, /- \[skill 6a98d9504ff33830c399cf66\] Security and compliance review — How to scope/);
  });

  test("the body is never rendered — it is what the cache carries instead", () => {
    const out = buildMemoryPrompt({
      agentMemory: { skills: [skill({ content: "SECRET_BODY_MARKER" })] },
    }, { skillFetch: true });
    assert.doesNotMatch(out, /SECRET_BODY_MARKER/);
  });

  test("content no longer substitutes for a missing description", () => {
    const out = buildMemoryPrompt({
      agentMemory: { skills: [skill({ description: "", content: "SECRET_BODY_MARKER" })] },
    }, { skillFetch: true });
    assert.match(out, /- \[skill 6a98d9504ff33830c399cf66\] Security and compliance review$/m);
    assert.doesNotMatch(out, /SECRET_BODY_MARKER/);
  });

  test("the section header tells the model how to reach a body", () => {
    const out = buildMemoryPrompt({ agentMemory: { skills: [skill()] } }, { skillFetch: true });
    assert.match(out, /### Agent skills — .*mem_skill/);
  });
});

describe("agent cases are not rendered anywhere", () => {
  test("a bundle of nothing but cases renders an empty block", () => {
    const out = buildMemoryPrompt({
      agentMemory: {
        cases: [{ taskIntent: "Diagnose MCP not loading", approach: "Reinstall", keyInsight: "stale config" }],
        skills: [],
      },
    });
    assert.equal(out, "", "cases must not open a section of their own");
  });

  test("cases are dropped even when other sections render", () => {
    const out = buildMemoryPrompt({
      memories: [{ type: "episodic_memory", summary: "an episode" }],
      agentMemory: {
        cases: [{ taskIntent: "Diagnose MCP not loading", approach: "Reinstall" }],
        skills: [skill()],
      },
    }, { skillFetch: true });
    assert.match(out, /### Episodic memory/);
    assert.match(out, /### Agent skills/);
    assert.doesNotMatch(out, /### Past task cases/);
    assert.doesNotMatch(out, /Diagnose MCP not loading/);
    assert.doesNotMatch(out, /\[case\]/);
  });
});

describe("skill body cache", () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "everme-skill-cache-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("round-trips a body by id", async () => {
    const cache = createSkillContentCache({ stateDir: dir });
    assert.equal(await cache.write([skill()]), 1);
    const got = await cache.read("6a98d9504ff33830c399cf66");
    assert.equal(got.content, "## Steps\n1. Scope the review\n2. Check the diff");
    assert.equal(got.name, "Security and compliance review");
    assert.equal(got.description, "How to scope and run a review before a release");
    assert.ok(got.cachedAt, "a cached body must record when it was written");
  });

  test("an id that was never cached reads as a miss, not as empty content", async () => {
    const cache = createSkillContentCache({ stateDir: dir });
    await cache.write([skill()]);
    assert.equal(await cache.read("ffffffffffffffffffffffff"), null);
  });

  test("a body with no id or no content is not written", async () => {
    const cache = createSkillContentCache({ stateDir: dir });
    assert.equal(await cache.write([skill({ id: "" }), skill({ id: "x", content: "" })]), 0);
    assert.deepEqual(await readdir(dir), []);
  });

  test("an empty id reads as a miss rather than hitting some default file", async () => {
    const cache = createSkillContentCache({ stateDir: dir });
    await cache.write([skill()]);
    assert.equal(await cache.read(""), null);
    assert.equal(await cache.read(null), null);
  });

  test("a corrupt cache file reads as a miss", async () => {
    const cache = createSkillContentCache({ stateDir: dir });
    await cache.write([skill()]);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, "6a98d9504ff33830c399cf66.skill.json"), "{not json", "utf8");
    assert.equal(await cache.read("6a98d9504ff33830c399cf66"), null);
  });

  test("files land under the shared state dir with the same 0600 / 0700 modes as every other state file", async () => {
    const cache = createSkillContentCache({ stateDir: path.join(dir, "state") });
    await cache.write([skill()]);
    const dirInfo = await stat(path.join(dir, "state"));
    assert.equal(dirInfo.mode & 0o777, 0o700);
    const fileInfo = await stat(path.join(dir, "state", "6a98d9504ff33830c399cf66.skill.json"));
    assert.equal(fileInfo.mode & 0o777, 0o600);
  });

  test("the file name ends in .json so the existing stale-state sweep expires it", async () => {
    const cache = createSkillContentCache({ stateDir: dir });
    await cache.write([skill()]);
    const [name] = await readdir(dir);
    assert.ok(name.endsWith(".skill.json"), `expected a .skill.json file, got ${name}`);
    const parsed = JSON.parse(await readFile(path.join(dir, name), "utf8"));
    assert.equal(parsed.id, "6a98d9504ff33830c399cf66");
  });

  test("the default directory is the shared hook state dir", async () => {
    const previous = process.env.EVERME_STATE_DIR;
    process.env.EVERME_STATE_DIR = dir;
    try {
      // No stateDir argument: the hook process and the MCP process both land
      // here, which is the entire reason the handoff needs no configuration.
      const cache = createSkillContentCache();
      await cache.write([skill()]);
      assert.equal((await cache.read("6a98d9504ff33830c399cf66")).content.startsWith("## Steps"), true);
    } finally {
      if (previous === undefined) delete process.env.EVERME_STATE_DIR;
      else process.env.EVERME_STATE_DIR = previous;
    }
  });
});

describe("searchMemory populates the cache", () => {
  let dir;
  let previous;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "everme-skill-search-"));
    previous = process.env.EVERME_STATE_DIR;
    process.env.EVERME_STATE_DIR = dir;
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env.EVERME_STATE_DIR;
    else process.env.EVERME_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });

  test("caches the bodies of the skills that cleared the threshold, and only those", async () => {
    const client = {
      async requestWithMeta() {
        return {
          result: {
            items: [],
            agentMemory: {
              cases: [{ taskIntent: "irrelevant" }],
              skills: [
                skill({ id: "kept", relevanceScore: 0.95, content: "KEPT BODY" }),
                skill({ id: "dropped", relevanceScore: 0.002, content: "DROPPED BODY" }),
              ],
            },
          },
          requestId: "req-1",
        };
      },
    };

    await searchMemory(client, { query: "security review", skillFetch: true });

    const cache = createSkillContentCache({ stateDir: dir });
    assert.equal((await cache.read("kept")).content, "KEPT BODY");
    assert.equal(await cache.read("dropped"), null,
      "a skill the prompt will never name must not leave a body behind");
  });

  test("an unwritable cache directory never fails the search", async () => {
    process.env.EVERME_STATE_DIR = path.join(dir, "not-a-dir");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, "not-a-dir"), "blocked", "utf8");
    const client = {
      async requestWithMeta() {
        return {
          result: { items: [{ summary: "hit" }], agentMemory: { skills: [skill()] } },
          requestId: "req-2",
        };
      },
    };
    const res = await searchMemory(client, { query: "security review", skillFetch: true });
    assert.equal(res.memories.length, 1, "recall must survive a cache it cannot write");
  });

  test("a host without the fetch capability leaves no cache files behind", async () => {
    // The gate on rendering and the gate on caching must be the same flag:
    // a prompt that never carries an id can never redeem one, so a body
    // written for it would be a file nothing could ever reference.
    const client = {
      async requestWithMeta() {
        return {
          result: {
            items: [],
            agentMemory: { skills: [skill({ id: "ungated", relevanceScore: 0.95, content: "BODY" })] },
          },
          requestId: "req-2",
        };
      },
    };

    await searchMemory(client, { query: "security review" });

    const cache = createSkillContentCache({ stateDir: dir });
    assert.equal(await cache.read("ungated"), null, "no body may be cached without the capability");
  });
});
