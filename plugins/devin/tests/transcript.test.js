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
    const messages = await readLastTurn(fixture);

    assert.deepEqual(messages, [
      { role: "user", content: "create a hello world file" },
      { role: "assistant", content: "I'll create a hello world file for you." },
      { role: "assistant", content: "I created the file for you." },
    ]);
    assert.doesNotMatch(JSON.stringify(messages), /print\('hello world'\)/);
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
