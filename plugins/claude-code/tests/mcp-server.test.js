/**
 * Bundled MCP server contract tests.
 *
 * Two regressions this file pins, both shipped broken in 0.3.1:
 *
 *  1. **Server startup (path bug)** — `mcp-server.js` did
 *     `createRequire(...)("../../../package.json")`, which from
 *     `hooks/scripts/mcp-server.js` lands in
 *     `node_modules/@everme/` (no package.json) and crashes the
 *     process on import. Claude Code surfaced this as
 *     `plugin:everme:everme ✗ Failed to connect`. The fix was
 *     `../../package.json`. A test that asserts the server responds
 *     to `initialize` would have caught it on day one.
 *
 *  2. **JSON envelope (rendering bug)** — the `mem_search` /
 *     `mem_context` tool handlers wrapped the SDK response in
 *     `ok(JSON.stringify(res, null, 2))`, forcing the host LLM to peel
 *     a JSON envelope and decode escaped newlines before any of the
 *     section bullets were readable. The fix routes both through
 *     `buildMemoryPrompt` / `renderProfileBlock` so the Tools surface
 *     matches the Resources surface in `@everme/memory-mcp`.
 *
 * Both tests spawn the server as a real subprocess via stdio JSON-RPC
 * — same pattern as hooks.test.js — and assert on stdout frames so
 * the path math and rendering pipeline are both exercised end-to-end.
 */

import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = path.join(__dirname, "..", "hooks", "scripts", "mcp-server.js");

const FAKE_CREDS = {
  EVERME_AGENT_TOKEN: "evt_test_0123456789abcdef",
  EVERME_AGENT_ID: "agt_test_0123456789abcdef",
};

// Minimal everme gateway: same envelope contract as hooks.test.js
// (`{status: 0, result: <payload>}` for success). Inlined rather than
// shared because shared test helpers in plugins/ aren't first-class
// yet and we want this file to be self-contained.
function startBackend(handler) {
  const calls = [];
  let lastHeaders = null;
  const srv = http.createServer((req, res) => {
    lastHeaders = req.headers;
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = null;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw) {
        try { body = JSON.parse(raw); } catch { body = raw; }
      }
      calls.push({ method: req.method, path: req.url, body });
      const out = handler({ method: req.method, path: req.url, body }) || { json: {} };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: 0, result: out.json ?? {} }));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      resolve({
        calls,
        get lastHeaders() { return lastHeaders; },
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

// Send a sequence of JSON-RPC frames to the server's stdin and collect
// responses from stdout. Returns a map { id → result|error } once all
// expected ids have come back, or rejects on timeout.
// `sequential` sends the next frame only after the previous one answered.
// The server reads stdin line by line and dispatches without awaiting, so a
// batch write races: a tools/call that depends on a side effect of an earlier
// call (mem_skill reading what mem_search cached) must be ordered the way a
// real host orders it — one request at a time.
async function rpc(env, frames, expectedIds, timeoutMs = 5000, { sequential = false } = {}) {
  const proc = spawn("node", [SERVER_SCRIPT], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses = new Map();
  let buf = "";
  let stderr = "";
  let next = 0;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`rpc timed out waiting for ids ${JSON.stringify(expectedIds)}; got ${JSON.stringify([...responses.keys()])}; stderr=${stderr}`));
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null) responses.set(msg.id, msg);
        } catch { /* ignore non-JSON debug lines */ }
        if (expectedIds.every((id) => responses.has(id))) {
          clearTimeout(timer);
          proc.kill();
          resolve(responses);
          return;
        }
        if (sequential && next < frames.length && responses.has(frames[next - 1].id)) {
          proc.stdin.write(JSON.stringify(frames[next]) + "\n");
          next += 1;
        }
      }
    });
    proc.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
    proc.on("error", reject);

    if (sequential) {
      proc.stdin.write(JSON.stringify(frames[0]) + "\n");
      next = 1;
      return;
    }
    for (const f of frames) {
      proc.stdin.write(JSON.stringify(f) + "\n");
    }
  });
}

describe("mcp-server.js: stdio handshake (regression: path bug)", () => {
  test("initialize succeeds — proves the package.json require path resolves", async () => {
    // No backend needed: initialize is purely local. If the
    // `createRequire(...)("../../package.json")` is wrong, node throws
    // MODULE_NOT_FOUND before reading any stdin and `rpc` times out.
    const responses = await rpc(
      { ...FAKE_CREDS, EVERME_API_BASE: "http://127.0.0.1:1" },
      [{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }],
      [1],
    );
    const init = responses.get(1);
    assert.ok(init?.result, `initialize must return a result; got: ${JSON.stringify(init)}`);
    assert.equal(init.result.serverInfo?.name, "everme");
    assert.ok(init.result.serverInfo?.version, "serverInfo.version must be populated from package.json — empty here means the require failed silently");
    assert.deepEqual(init.result.capabilities?.tools, { listChanged: false });
  });

  test("tools/list advertises exactly the three read tools", async () => {
    const responses = await rpc(
      { ...FAKE_CREDS, EVERME_API_BASE: "http://127.0.0.1:1" },
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      ],
      [1, 2],
    );
    const tools = responses.get(2)?.result?.tools || [];
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "mem_context",
      "mem_search",
      "mem_skill",
    ]);
    // Canonical ABI guards — keep in lockstep with @everme/memory-mcp and
    // the Go hosted /mcp surface. The write tools were retired.
    assert.deepEqual(byName.mem_search.inputSchema.required, ["query"]);
    assert.equal(byName.mem_context.inputSchema.required, undefined,
      "mem_context has no required fields — Profile-only, query deprecated/ignored");
    assert.ok(byName.mem_context.inputSchema.properties.forceRefresh);
    assert.deepEqual(byName.mem_skill.inputSchema.required, ["id"]);
    assert.ok(!byName.mem_save_turn, "mem_save_turn was retired");
    assert.ok(!byName.mem_save_fact, "mem_save_fact was retired");
  });

  test("legacy everme_* tool names are rejected", async () => {
    const responses = await rpc(
      { ...FAKE_CREDS, EVERME_API_BASE: "http://127.0.0.1:1" },
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "everme_search", arguments: { query: "durian" } } },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "everme_context", arguments: {} } },
      ],
      [1, 2, 3],
    );
    for (const id of [2, 3]) {
      const result = responses.get(id)?.result;
      assert.equal(result?.isError, true);
      assert.match(result?.content?.[0]?.text || "", /unknown tool/);
    }
  });
});

describe("mcp-server.js: tool responses are raw markdown (regression: JSON envelope)", () => {
  let backend;
  before(async () => {
    backend = await startBackend(({ path: url }) => {
      if (url === "/api/v1/mem/search") {
        return {
          json: {
            // Backend returns `items` — agent-sdk's searchMemory
            // rebrands it to `memories` at the SDK boundary. Mocking
            // `memories` here would silently fall through to
            // buildMemoryPrompt's "no matches" path. See the matching
            // gotcha in memory-mcp's tests/resources.test.js.
            items: [{ episode: "User said they like durian as a snack." }],
            profiles: [],
            rawMessages: [],
            agentMemory: { cases: [], skills: [] },
          },
        };
      }
      if (url === "/api/v1/mem/context") {
        // getContext returns the gateway's raw shape with a structured
        // `profile` field — renderProfileBlock turns it into markdown.
        // Real wire shape consumed by the shared profile renderer: explicit
        // entries carry `{category, description, evidence?, sources?}`,
        // NOT `content`. Mocking `content` would let renderProfileBlock
        // emit an empty `<everme_profile>` block because the field-name
        // miss is silent (`desc || evidence || ""` falls through).
        return {
          json: {
            profile: {
              explicit_info: [
                { category: "Preferences", description: "iced americano in the morning" },
              ],
            },
          },
        };
      }
      return { json: {} };
    });
  });
  after(async () => { await backend.close(); });

  test("mem_search returns rendered markdown sections, not JSON.stringify of the bundle", async () => {
    const responses = await rpc(
      { ...FAKE_CREDS, EVERME_API_BASE: backend.url },
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mem_search", arguments: { query: "durian", topK: 3 } } },
      ],
      [1, 2],
    );
    const text = responses.get(2)?.result?.content?.[0]?.text;
    assert.ok(text, `tools/call result must have content[0].text; got: ${JSON.stringify(responses.get(2))}`);
    assert.match(text, /^## EverMe search results for "durian"/, "must lead with the search-results header — same as @everme/memory-mcp's mem_search");
    assert.match(text, /User said they like durian/, "rendered body must surface the episodic memory text via buildMemoryPrompt");
    assert.ok(!text.startsWith("{"), "result text must not start with `{` — that means JSON.stringify wrapping is back");
    assert.ok(!text.includes('"memories":'), 'result text must not contain the literal `"memories":` JSON key from the searchMemory bundle');
  });

  // The fixed text names the brand of the credentials; memory content is the
  // user's and stays as stored.
  test("mem_search names EverOS in its header under the EverOS brand", async () => {
    const responses = await rpc(
      { ...FAKE_CREDS, EVERME_API_BASE: backend.url, EVERME_BRAND: "everos" },
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mem_search", arguments: { query: "durian", topK: 3 } } },
      ],
      [1, 2],
    );
    const text = responses.get(2)?.result?.content?.[0]?.text;
    assert.match(text, /^## EverOS search results for "durian"/);
    assert.match(text, /User said they like durian/);
  });

  test("an unconfigured server names EverOS under the EverOS brand", async () => {
    const responses = await rpc(
      {
        EVERME_API_BASE: backend.url,
        EVERME_BRAND: "everos",
        EVERME_AGENT_TOKEN: "",
        EVERME_API_KEY: "",
        EVERME_ENV_FILE_PATH: path.join(os.tmpdir(), "everos-mcp-test-no-such-env"),
        HOME: os.tmpdir(),
      },
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mem_search", arguments: { query: "durian" } } },
      ],
      [1, 2],
    );
    const text = responses.get(2)?.result?.content?.[0]?.text;
    assert.match(text, /EverOS not configured/);
    assert.doesNotMatch(text, /EverMe/);
  });

  test("mem_context returns rendered profile markdown, not the gateway envelope", async () => {
    const responses = await rpc(
      { ...FAKE_CREDS, EVERME_API_BASE: backend.url },
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mem_context", arguments: {} } },
      ],
      [1, 2],
    );
    const text = responses.get(2)?.result?.content?.[0]?.text;
    assert.ok(text, `tools/call result must have content[0].text; got: ${JSON.stringify(responses.get(2))}`);
    assert.ok(!text.startsWith("{"), "result text must not start with `{` — that means JSON.stringify wrapping is back");
    assert.ok(!text.includes('"profile":'), 'result text must not contain the literal `"profile":` JSON key from the gateway envelope');
    assert.ok(!text.includes('"explicit_info":'), 'result text must not contain the structured field name `explicit_info` — renderProfileBlock should have unwrapped it');
    assert.match(text, /iced americano in the morning/, "rendered profile must surface preference content via renderProfileBlock");
  });
});

describe("mcp-server.js: canonical mem_* tools", () => {
  let backend;
  before(async () => {
    backend = await startBackend(({ path: url, body }) => {
      if (url === "/api/v1/mem/search") {
        return {
          json: {
            items: [{ episode: "Raven MR !103 landed with scheme C." }],
            profiles: [],
            rawMessages: [],
            agentMemory: { cases: [], skills: [] },
          },
        };
      }
      if (url === "/api/v1/mem/context") {
        return {
          json: {
            profile: {
              explicit_info: Array.from({ length: 13 }, (_, index) => ({
                category: "pet",
                description: index === 0 ? "corgi named Bytie" : `profile fact ${index + 1}`,
              })),
            },
          },
        };
      }
      if (url === "/api/v1/mem/personal") {
        return { json: { sessionId: "s", status: "no_extraction", messageCount: 1, flushed: true, extracted: false } };
      }
      if (url === "/api/v1/mem/agent-memory") {
        return {
          json: {
            sessionId: "s",
            status: "accumulated",
            messageCount: body?.messages?.length || 0,
            flushed: !!body?.flush,
            personalStatus: "extracted",
            personalExtracted: true,
          },
        };
      }
      return { json: {} };
    });
  });
  after(async () => { await backend.close(); });

  test("mem_search renders markdown and leaves memoryTypes to the gateway default", async () => {
    const responses = await rpc(
      { ...FAKE_CREDS, EVERME_API_BASE: backend.url },
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mem_search", arguments: { query: "raven" } } },
      ],
      [1, 2],
    );
    const text = responses.get(2)?.result?.content?.[0]?.text;
    assert.ok(text);
    assert.match(text, /^## EverMe search results for "raven"/);
    const call = backend.calls.find((c) => c.path === "/api/v1/mem/search");
    assert.equal(call?.body?.memoryTypes, undefined, "no memoryTypes narrowing — the gateway default covers the full bundle");
    const pkg = createRequire(import.meta.url)("../package.json");
    assert.equal(backend.lastHeaders["x-everme-client"], `mcp/${pkg.version}`);
  });

  test("mem_context forwards forceRefresh and ignores query", async () => {
    const responses = await rpc(
      { ...FAKE_CREDS, EVERME_API_BASE: backend.url },
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mem_context", arguments: { query: "should be ignored", forceRefresh: true } } },
      ],
      [1, 2],
    );
    const text = responses.get(2)?.result?.content?.[0]?.text;
    assert.match(text, /^```memory\n## Relevant memory/);
    assert.match(text, /corgi named Bytie/);
    assert.match(text, /profile fact 13/, "MCP mem_context must not inherit the hook renderer's 12-fact truncation");
    assert.doesNotMatch(text, /<everme_profile>/, "MCP tool output follows the canonical memory-mcp markdown renderer");
    const call = backend.calls.find((c) => c.path === "/api/v1/mem/context");
    assert.deepEqual(call?.body, { forceRefresh: true }, "body must carry forceRefresh only — no query");
  });


});

describe("mcp-server.js: mem_context empty-profile fallback (regression: empty tool result)", () => {
  // New EverMe accounts return /mem/context with a `profile` object that
  // has empty `explicit_info` and `implicit_traits`. The canonical context
  // renderer returns "" for that shape; the handler must still surface a
  // non-empty fallback so the host does not see a silent success.
  let backend;
  before(async () => {
    backend = await startBackend(({ path: url }) => {
      if (url === "/api/v1/mem/context") {
        return { json: { profile: { explicit_info: [], implicit_traits: [], memcell_count: 0 } } };
      }
      return { json: {} };
    });
  });
  after(async () => { await backend.close(); });

  test("empty profile object yields the fallback message, not an empty string", async () => {
    const responses = await rpc(
      { ...FAKE_CREDS, EVERME_API_BASE: backend.url },
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mem_context", arguments: {} } },
      ],
      [1, 2],
    );
    const text = responses.get(2)?.result?.content?.[0]?.text;
    assert.ok(text && text.length > 0, `mem_context must not return empty content for a profile with no facts/traits; got: ${JSON.stringify(responses.get(2))}`);
    assert.match(text, /no profile available/, "empty-profile case must surface the friendly fallback message");
  });
});

describe("mcp-server.js: progressive skill loading", () => {
  const SKILL = {
    id: "6a98d9504ff33830c399cf66",
    name: "Security and compliance review",
    description: "How to scope and run a review before a release",
    content: "## Steps\n1. Scope the review\n2. Check the diff",
    relevanceScore: 0.99,
  };
  let backend;
  let stateDir;
  before(async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), "everme-cc-skill-"));
    backend = await startBackend(({ path: url }) => {
      if (url !== "/api/v1/mem/search") return { json: {} };
      return {
        json: {
          items: [],
          profiles: [],
          rawMessages: [],
          agentMemory: {
            cases: [{ taskIntent: "Diagnose MCP not loading", approach: "Reinstall" }],
            skills: [SKILL, { ...SKILL, id: "weak", name: "Unrelated", relevanceScore: 0.002, content: "WEAK BODY" }],
          },
        },
      };
    });
  });
  after(async () => {
    await backend.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  test("mem_search prints skill ids without bodies, and mem_skill reads a body back by id", async () => {
    // One process does both halves, which is the point: the search writes the
    // body into the shared state dir and a later tool call reads it from
    // there. In production the two halves are different processes (recall runs
    // in a hook), and they meet because both default to the same directory.
    const responses = await rpc(
      { ...FAKE_CREDS, EVERME_API_BASE: backend.url, EVERME_STATE_DIR: stateDir },
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mem_search", arguments: { query: "security review" } } },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mem_skill", arguments: { id: SKILL.id } } },
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "mem_skill", arguments: { id: "weak" } } },
        { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "mem_skill", arguments: { id: "ffffffffffffffffffffffff" } } },
      ],
      [1, 2, 3, 4, 5],
      5000,
      { sequential: true },
    );

    const search = responses.get(2)?.result?.content?.[0]?.text || "";
    assert.match(search, /\[skill 6a98d9504ff33830c399cf66\]/, "the rendered line must carry the id");
    assert.doesNotMatch(search, /Scope the review/, "the body must not be injected");
    assert.doesNotMatch(search, /Past task cases/, "cases are no longer rendered");
    assert.doesNotMatch(search, /Diagnose MCP not loading/);
    assert.doesNotMatch(search, /Unrelated/, "a below-threshold skill is not rendered");

    const hit = responses.get(3)?.result;
    assert.ok(!hit?.isError, `mem_skill must resolve an id the search just cached; got ${JSON.stringify(hit)}`);
    assert.match(hit.content[0].text, /1\. Scope the review/);

    const weak = responses.get(4)?.result;
    assert.equal(weak?.isError, true, "a skill below the render threshold is never cached, so its id misses");

    const miss = responses.get(5)?.result;
    assert.equal(miss?.isError, true, "an unknown id must be an honest miss");
    assert.match(miss.content[0].text, /not in this machine's local skill cache/);
    assert.doesNotMatch(miss.content[0].text, /Scope the review/);
  });
});
