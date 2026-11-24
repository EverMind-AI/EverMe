import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brandOf, brandStrings, recallTag, profileTag, INJECTED_TAGS } from "../src/brand.js";
import { runInject } from "../src/hooks/inject.js";
import { renderProfileBlock } from "../src/hooks/session-start.js";
import { extractUserIntent } from "../src/hooks/query.js";
import { dropEvermeMemoryToolPairs } from "../src/everme-injection.js";
import { createClient } from "../src/client.js";
import { runHostHook, resolveRuntimeConfig } from "../src/hooks/runtime.js";

test("brand comes from EVERME_BRAND and defaults to everme", () => {
  assert.equal(brandOf({}), "everme");
  assert.equal(brandOf({ EVERME_BRAND: "everos" }), "everos");
  assert.equal(brandOf({ EVERME_BRAND: "something-else" }), "everme");
  assert.equal(recallTag("everos"), "everos_recall");
  assert.equal(profileTag("everme"), "everme_profile");
  assert.deepEqual(new Set(INJECTED_TAGS), new Set(["everme_recall", "everme_profile", "everos_recall", "everos_profile"]));
});

test("recall block uses the brand's tag", async () => {
  const search = async () => ({ memories: [{ episode: "fixed the discount bug", score: 0.9 }], profiles: [], rawMessages: [] });
  const config = { injectTopK: 5, injectMinScore: 0.3, injectProfile: false, brand: "everos" };
  const out = await runInject({ input: { prompt: "what was the root cause of the discount bug" }, client: {}, config, search, log: { info() {} } });
  assert.match(out.block, /^<everos_recall>\n[\s\S]*\n<\/everos_recall>$/);
});

test("profile block uses the brand's tag", () => {
  const profile = { explicit_info: [{ description: "likes summer" }] };
  assert.match(renderProfileBlock(profile, "everos"), /^<everos_profile>[\s\S]*<\/everos_profile>$/);
  assert.match(renderProfileBlock(profile), /^<everme_profile>[\s\S]*<\/everme_profile>$/);
});

// Both brands can run in one host, so each must strip the other's blocks
// too: otherwise EverMe would store EverOS's recall as a new memory.
test("recall query strips both brands' blocks", () => {
  const prompt = "<everos_recall>\nold memory\n</everos_recall>\n<everme_recall>\nother\n</everme_recall>\nwhat changed in the billing service";
  const { query } = extractUserIntent(prompt);
  assert.equal(query.includes("old memory"), false);
  assert.equal(query.includes("other"), false);
  assert.match(query, /billing service/);
});

test("memory tool calls of either brand's MCP server are dropped before upload", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "", toolCalls: [{ id: "a", name: "mcp__everos-memory__mem_search", arguments: "{}" }] },
    { role: "tool", toolCallId: "a", content: "memories" },
    { role: "assistant", content: "done" },
  ];
  const kept = dropEvermeMemoryToolPairs(messages);
  assert.equal(kept.some((m) => m.toolCallId === "a"), false);
});

test("the client reads the device route from its own memory home", async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "ok", status: 0, requestId: "r", result: {} }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const home = mkdtempSync(join(tmpdir(), "everos-home-"));
  writeFileSync(join(home, "route.json"), JSON.stringify({ mode: "local", apiBase: `http://127.0.0.1:${port}` }));
  try {
    const client = createClient({ apiBase: "http://127.0.0.1:9", agentToken: "evt_x", memoryHome: home });
    await client.request("POST", "/mem/context", {});
    assert.deepEqual(seen, ["/api/v1/mem/context"]);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test("brandStrings rewrites wording and tags for EverOS only", () => {
  const text = "When a <everme_recall> block appears, EverMe memory is in context.";
  assert.equal(brandStrings(text, "everme"), text);
  assert.equal(brandStrings(text, "everos"), "When a <everos_recall> block appears, EverOS memory is in context.");
  assert.deepEqual(brandStrings([{ description: "EverMe <everme_profile>", name: "mem_search" }], "everos"),
    [{ description: "EverOS <everos_profile>", name: "mem_search" }]);
});

test("the host's status line names the brand; the recalled memory is left as written", async () => {
  const adapter = {
    platform: "test-host",
    version: "1.0.0",
    normalizeInput(rawInput) {
      return rawInput;
    },
    formatOutput(event, { block = "", count = 0 } = {}) {
      return {
        systemMessage: `🧠 EverMe loaded ${count} memory item from past sessions`,
        hookSpecificOutput: { hookEventName: event, additionalContext: block },
      };
    },
  };
  const block = "<everos_profile>\n- the user maintains the EverMe plugin\n</everos_profile>";
  const run = (brand) => runHostHook("SessionStart", { sessionId: "s" }, adapter, {
    env: { EVERME_BRAND: brand },
    config: { isConfigured: true, authMode: "evt", agentId: "agt_x", agentToken: "evt_x", injectTopK: 5, injectMinScore: 0.3, flushEveryTurns: 5 },
    createClient: () => ({ async request() { return {}; } }),
    runSessionStart: async () => ({ block, count: 1 }),
  });

  const everos = await run("everos");
  assert.equal(everos.systemMessage, "🧠 EverOS loaded 1 memory item from past sessions");
  assert.equal(everos.hookSpecificOutput.additionalContext, block);

  const everme = await run("everme");
  assert.equal(everme.systemMessage, "🧠 EverMe loaded 1 memory item from past sessions");
});

test("the hook runtime takes its recall floor from the route of its memory home", () => {
  const home = mkdtempSync(join(tmpdir(), "everos-floor-"));
  writeFileSync(join(home, "route.json"), JSON.stringify({ mode: "local", apiBase: "http://127.0.0.1:47391", injectMinScore: 0.1 }));
  assert.equal(resolveRuntimeConfig({ EVERME_MEMORY_HOME: home }).injectMinScore, 0.1);
  assert.equal(resolveRuntimeConfig({ EVERME_MEMORY_HOME: home, EVERME_INJECT_MIN_SCORE: "0.2" }).injectMinScore, 0.2);
});
