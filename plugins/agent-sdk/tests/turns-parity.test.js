import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { turnOrdinals, splitTurnAligned, completedTurns } from "../index.js";
import { batchAgentMessages } from "../src/agent-batches.js";

// Mirrors cli/internal/importer/conversation turn_parity_test.go: the Go
// importer reads the same fixture, so hook and import writes of one session
// keep agreeing on every turn ordinal.
const fixture = JSON.parse(readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "turn-coordinates.json"),
  "utf8",
));

describe("turn coordinates match the Go importer fixture", () => {
  for (const tc of fixture.cases) {
    test(tc.name, () => {
      const messages = tc.roles.map((role, i) => ({ role, timestamp: i + 1, content: "x" }));
      assert.deepEqual(turnOrdinals(messages), tc.ordinals);
      const slices = splitTurnAligned(messages, tc.max);
      assert.deepEqual(batchAgentMessages(messages, tc.max, [], true), slices);
      let flat = 0;
      const groups = slices.map((s) => {
        const idx = s.map((_, j) => flat + j);
        flat += s.length;
        return idx;
      });
      assert.deepEqual(groups, tc.batches);
      assert.deepEqual(slices.map((_, i) => completedTurns(slices, i, tc.baseTurn)), tc.completed);
    });
  }
});
