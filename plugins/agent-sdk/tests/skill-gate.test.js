/**
 * Host-capability gate on the injected skill id.
 *
 * Only a host that ships mem_skill alongside its hook can redeem an id, so
 * the id — and the sentence naming the tool — appear only when the adapter
 * declared skillFetch. A host that never declared it must get a block that
 * is byte-for-byte the one it got before ids existed: an id it cannot spend
 * is noise, and a tool name it does not have is a false promise.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildMemoryPrompt } from "../src/prompt.js";
import { withClientIdentity } from "../src/hooks/runtime.js";

function skill(overrides = {}) {
  return {
    id: "sk_1",
    name: "N",
    description: "D",
    content: "BODY",
    relevanceScore: 0.99,
    ...overrides,
  };
}

function bundle(overrides = {}) {
  return { agentMemory: { cases: [], skills: [skill(overrides)] } };
}

describe("skill id is gated on the host capability", () => {
  test("L1-1 skillFetch:true prints the id and names the tool, never the body", () => {
    const out = buildMemoryPrompt(bundle(), { skillFetch: true });
    assert.match(out, /- \[skill sk_1\] N — D/);
    assert.match(out, /mem_skill/);
    assert.doesNotMatch(out, /BODY/);
  });

  test("L1-2 skillFetch:false renders no skill section at all", () => {
    // A row the host cannot redeem is worse than no row: it spends context
    // advertising a method the model can never read, and invites it to claim
    // a documented procedure it has not seen.
    const out = buildMemoryPrompt(bundle(), { skillFetch: false });
    assert.doesNotMatch(out, /Agent skills/);
    assert.doesNotMatch(out, /sk_1/);
    assert.doesNotMatch(out, /mem_skill/);
    assert.doesNotMatch(out, /BODY/);
    assert.doesNotMatch(out, /\[skill\]/);
  });

  test("L1-1b the call to action is repeated as the LAST line of the block", () => {
    // The header sits above up to 2,500 tokens of episodic narrative. The
    // trailer is the same instruction where recency actually helps, so it
    // must genuinely be last — not merely present.
    const out = buildMemoryPrompt(bundle(), { skillFetch: true });
    const lines = out.trimEnd().split("\n");
    assert.match(lines[lines.length - 1], /call mem_skill with its id/);
    assert.match(lines[lines.length - 1], /before starting/);
  });

  test("L1-1c no skill section means no trailing directive", () => {
    // The trailer is an instruction about skill rows. With no rows it would
    // be an order to act on something that is not there.
    const out = buildMemoryPrompt({ memories: [{ type: "episodic_memory", summary: "e" }] }, { skillFetch: true });
    assert.doesNotMatch(out, /mem_skill/);
  });

  test("L1-3 omitting the option is byte-for-byte the gated-off shape", () => {
    // The default has to be the closed one, so a host added later without a
    // declaration silently gets no id rather than silently getting a dangling
    // one.
    assert.equal(buildMemoryPrompt(bundle()), buildMemoryPrompt(bundle(), { skillFetch: false }));
  });

  test("L1-4 a truthy non-boolean does not open the gate", () => {
    // An adapter that writes skillFetch: "true" is a declaration bug, not a
    // capability. Anything but the boolean falls back to closed.
    assert.equal(
      buildMemoryPrompt(bundle(), { skillFetch: "true" }),
      buildMemoryPrompt(bundle(), { skillFetch: false }),
    );
  });

  test("L1-5 a skill below the score floor opens no section in either shape", () => {
    assert.equal(buildMemoryPrompt(bundle({ relevanceScore: 0.05 }), { skillFetch: true }), "");
    assert.equal(buildMemoryPrompt(bundle({ relevanceScore: 0.05 }), { skillFetch: false }), "");
  });

  test("L1-6 a skill exactly at the floor renders", () => {
    assert.match(buildMemoryPrompt(bundle({ relevanceScore: 0.1 }), { skillFetch: true }), /### Agent skills/);
  });

  test("L1-7 a skill with no score field still renders — field-absent defence", () => {
    const row = skill();
    delete row.relevanceScore;
    const out = buildMemoryPrompt({ agentMemory: { skills: [row] } }, { skillFetch: true });
    assert.match(out, /- \[skill sk_1\] N — D/);
  });

  test("L1-8 a bundle of nothing but cases renders empty under both shapes", () => {
    const cases = { agentMemory: { cases: [{ taskIntent: "T", approach: "A", keyInsight: "K" }], skills: [] } };
    assert.equal(buildMemoryPrompt(cases, { skillFetch: true }), "");
    assert.equal(buildMemoryPrompt(cases, { skillFetch: false }), "");
  });
});

describe("the capability reaches the renderer through the hook config", () => {
  test("the logged count never claims rows the block does not carry", async () => {
    // countBundle and the renderer must apply the SAME gates. They briefly
    // did not: skills were counted under the score filter alone, so a host
    // without the capability logged a row the model never saw.
    const { runInject } = await import("../src/hooks/inject.js");
    const res = {
      memories: [{ type: "episodic_memory", summary: "an episode", relevanceScore: 0.9 }],
      profiles: [],
      rawMessages: [],
      agentMemory: { skills: [{ id: "sk_1", name: "N", description: "D", relevanceScore: 0.99 }] },
    };
    const run = (skillFetch) =>
      runInject({
        input: { prompt: "help me with a security review" },
        client: {},
        config: { injectTopK: 5, injectMinScore: 0.3, injectProfile: false, skillFetch },
        search: async () => res,
        log: { info() {} },
      });

    const closed = await run(false);
    assert.equal(closed.count, 1, "the skill is not rendered, so it must not be counted");
    assert.doesNotMatch(closed.block, /Agent skills/);

    const open = await run(true);
    assert.equal(open.count, 2);
    assert.match(open.block, /Agent skills/);
  });

  test("L1-9 an adapter declaring the capability carries it into config", () => {
    assert.equal(withClientIdentity({}, { skillFetch: true }).skillFetch, true);
  });

  test("L1-10 an adapter that declares nothing is closed, not undefined", () => {
    assert.equal(withClientIdentity({}, {}).skillFetch, false);
  });
});
