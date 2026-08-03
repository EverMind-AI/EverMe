/**
 * Skill copy guards (autonomy contract).
 *
 * Hosts load the skill by its frontmatter description before reading the
 * body, so the description must carry the implicit recall/save triggers
 * itself. The body must keep the <everme_recall> dedupe protocol and must
 * never regress to the blanket "usually do NOT need to call" suppression
 * that stopped models from ever calling the tools.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL = readFileSync(path.join(__dirname, "..", "skills", "memory-tools.md"), "utf8");
const README = readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
const RECALL_COMMAND = readFileSync(path.join(__dirname, "..", "commands", "recall.md"), "utf8");
const HELP_COMMAND = readFileSync(path.join(__dirname, "..", "commands", "everme-help.md"), "utf8");

describe("memory-tools skill copy", () => {
  test("frontmatter description carries implicit recall + durable-fact triggers", () => {
    const frontmatter = SKILL.split("---")[1] || "";
    assert.match(frontmatter, /last time/i);
    assert.match(frontmatter, /remember when/i);
    assert.match(frontmatter, /preferences|habits|decisions/i);
  });

  test("body keeps the <everme_recall> dedupe protocol", () => {
    assert.match(SKILL, /<everme_recall>/);
    assert.match(SKILL, /missing, empty, or clearly unrelated/i);
  });

  test("no unconditional suppression copy", () => {
    assert.doesNotMatch(SKILL, /usually do NOT need to call/i);
  });

  test("extraction verdict honesty is spelled out", () => {
    assert.match(SKILL, /no_extraction/);
    assert.match(SKILL, /profileUpdated/);
    assert.match(SKILL, /chat-dual-write/i);
  });

  test("published guidance uses only the canonical four MCP tool names", () => {
    const publishedCopy = [SKILL, README, RECALL_COMMAND, HELP_COMMAND].join("\n");
    assert.doesNotMatch(publishedCopy, /everme_search|everme_context/);
    for (const tool of ["mem_search", "mem_context", "mem_save_fact", "mem_save_turn"]) {
      assert.match(publishedCopy, new RegExp(`\\b${tool}\\b`));
    }
  });
});
