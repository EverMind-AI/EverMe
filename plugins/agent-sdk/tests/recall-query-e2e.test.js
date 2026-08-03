/**
 * End-to-end proof for recall-query hygiene.
 *
 * Unit tests can assert what extractUserIntent returns; they cannot prove what
 * leaves the process. These tests drive the real recall path — hook input ->
 * runInject -> searchMemory -> createClient -> HTTP — against a local server
 * that captures the actual request body, and they capture the diagnostic line
 * the operator will grep for. If the query on the wire ever regresses to a
 * whole prompt payload, this fails.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";

import { createClient } from "../index.js";
import { runInject } from "../src/hooks/inject.js";

// A prompt shaped like what hosts really hand a UserPromptSubmit hook: a
// reminder block carrying project instructions, an IDE selection, a pasted log
// dump, our own memory block echoed back, and one real question at the end.
function noisyHostPrompt() {
  return [
    "<system-reminder>",
    "As you answer the user's questions, you can use the following context:",
    "# claudeMd",
    "Codebase and user instructions are shown below. Be sure to adhere to these instructions. ".repeat(40),
    "</system-reminder>",
    "<ide_selection>server/internal/biz/memory/search.go lines 58-77</ide_selection>",
    "<everme_recall>",
    "- [pet] has a guinea pig named Oscar",
    "- [preference] likes durian",
    "</everme_recall>",
    "```",
    "2026-07-30 08:30:47.107 ERROR core/core.go:44 api response error {errno: 50301}".repeat(50),
    "```",
    "why is agent-memory still returning 503?",
  ].join("\n");
}

let server;
let baseUrl;
const received = [];

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      received.push({ path: req.url, body: JSON.parse(raw || "{}") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: 0, data: { items: [], profiles: [] } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("recall query on the wire", () => {
  test("a noisy host prompt reaches /mem/search as the question alone", async () => {
    received.length = 0;
    const lines = [];
    const client = createClient({ baseUrl, agentToken: "evt_test", agentId: "agt_test" });

    const prompt = noisyHostPrompt();
    await runInject({
      input: { prompt },
      client,
      config: { injectTopK: 5, injectMinScore: 0.1, injectProfile: false },
      log: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    });

    assert.equal(received.length, 1, "exactly one search request");
    assert.equal(received[0].path, "/api/v1/mem/search");

    const sent = received[0].body.query;
    assert.ok(prompt.length > 4000, "the host payload really is huge");
    assert.ok(sent.length < 120, `query on the wire should be short, got ${sent.length}: ${sent}`);
    assert.ok(sent.includes("why is agent-memory still returning 503?"), "the question survives");
    assert.ok(!sent.includes("system-reminder"), "no reminder markup on the wire");
    assert.ok(!sent.includes("claudeMd"), "no injected project instructions on the wire");
    assert.ok(!sent.includes("guinea pig"), "our own recall block is not searched back");
    assert.ok(!sent.includes("core.go"), "no log dump on the wire");

    // The operator-visible evidence: one greppable line with the reduction.
    const statLine = lines.find((line) => line.includes("recall query:"));
    assert.ok(statLine, `expected a recall-query diagnostic, got ${JSON.stringify(lines)}`);
    assert.match(statLine, /raw=\d{4,} query=\d{1,3} clamped=false removed\{/);
    assert.match(statLine, /reminder:\d+/);
    assert.match(statLine, /everme:\d+/);
    assert.ok(!statLine.includes("durian"), "the diagnostic never carries user content");
  });

  test("a prompt that is only framework noise makes no search call at all", async () => {
    received.length = 0;
    const client = createClient({ baseUrl, agentToken: "evt_test", agentId: "agt_test" });

    await runInject({
      input: { prompt: "<system-reminder>load the skill</system-reminder>" },
      client,
      config: { injectTopK: 5, injectMinScore: 0.1, injectProfile: false },
      log: { info() {}, warn() {} },
    });

    assert.equal(received.length, 0, "nothing left to search for; no upstream call");
  });
});
