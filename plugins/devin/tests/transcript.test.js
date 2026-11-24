import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLastTurn } from "../src/transcript.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "devin-transcript.jsonl");

describe("Devin transcript parser", () => {
  test("returns the last user input and following planner responses", async () => {
    const warnings = [];
    const messages = await readLastTurn(fixture, { log: line => warnings.push(line) });

    assert.deepEqual(messages, [
      { role: "user", content: "create a hello world file" },
      { role: "assistant", content: "I'll create a hello world file for you." },
      { role: "assistant", content: "I created the file for you." },
    ]);
    assert.doesNotMatch(JSON.stringify(messages), /print\('hello world'\)/);
    assert.ok(warnings.includes("Devin transcript unsupported_tool_trace: dropped_steps=1"));
  });

  test("reports malformed and unsupported steps with bounded counts, not source content", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "everme-devin-transcript-"));
    const file = path.join(dir, "diagnostics.jsonl");
    try {
      const sensitive = "emk_" + "a".repeat(32);
      await writeFile(file, [
        "not-json " + sensitive,
        JSON.stringify({ status: "done", type: "code_action", code_action: { new_content: sensitive, path: "/private/source" } }),
        JSON.stringify({ status: "done", type: sensitive.repeat(50) }),
        JSON.stringify({ status: "done", type: "code_action", code_action: { new_content: "actual file text", path: "/file" } }),
        "",
      ].join("\n"));
      const warnings = [];
      assert.deepEqual(await readLastTurn(file, { log: line => warnings.push(line) }), []);
      assert.deepEqual(warnings, [
        "Devin transcript invalid_json: dropped_steps=1",
        "Devin transcript unsupported_tool_trace: dropped_steps=2",
        "Devin transcript unsupported_step_type: dropped_steps=1",
      ]);
      assert.ok(warnings.every(line => line.length < 100));
      assert.doesNotMatch(warnings.join("\n"), /emk_|private|actual file text/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ignores malformed and unknown transcript steps", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "everme-devin-transcript-"));
    const file = path.join(dir, "unsupported.jsonl");
    try {
      await writeFile(file, "not-json\n{\"type\":\"code_action\",\"code_action\":{\"new_content\":\"secret\"}}\n", "utf8");
      assert.deepEqual(await readLastTurn(file), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
