/**
 * Skill copy guards (autonomy contract) — see the matching test in
 * plugins/claude-code/tests/skills.test.js for the rationale.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_SKILL = readFileSync(path.join(__dirname, "..", "skills", "memory-tools", "SKILL.md"), "utf8");
const RECALL_SKILL = readFileSync(path.join(__dirname, "..", "skills", "memory-recall", "SKILL.md"), "utf8");

describe("memory-tools skill copy", () => {
  test("frontmatter description carries implicit recall + durable-fact triggers", () => {
    const frontmatter = TOOLS_SKILL.split("---")[1] || "";
    assert.match(frontmatter, /last time/i);
    assert.match(frontmatter, /remember when/i);
    assert.match(frontmatter, /preferences|habits|decisions/i);
  });

  test("body keeps the <everme_recall> dedupe protocol and honesty rules", () => {
    assert.match(TOOLS_SKILL, /<everme_recall>/);
    assert.match(TOOLS_SKILL, /missing, empty, or clearly unrelated/i);
    assert.match(TOOLS_SKILL, /no_extraction/);
    assert.match(TOOLS_SKILL, /profileUpdated/);
    assert.match(TOOLS_SKILL, /chat-dual-write/i);
  });

  test("no unconditional suppression copy", () => {
    assert.doesNotMatch(TOOLS_SKILL, /usually do NOT need to call/i);
  });
});

describe("memory-recall skill copy", () => {
  test("brands unextracted transcript as provisional", () => {
    assert.match(RECALL_SKILL, /Recent unextracted transcript/);
    assert.match(RECALL_SKILL, /provisional/i);
  });
});
