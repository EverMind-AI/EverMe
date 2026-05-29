/**
 * MCP Resources surface tests — A.3 in the iteration plan.
 *
 * Why this file exists: Codex App ≥ v0.128 bridges MCP to the LLM via
 * resources/read instead of tools/call. The Resources surface added in
 * src/mcp.js exposes `mem://profile` (static) and `mem://search?q=…`
 * (template) so Codex users get auto-recall. Tests below pin:
 *
 *   1. resources/list advertises mem://profile (round-trip via Client)
 *   2. resources/templates/list advertises mem://search?q={query}&topK={topK}
 *   3. resources/read on an unknown URI fails loudly (doesn't silently
 *      succeed with empty content — a regression there would let a host
 *      think the resource exists when it doesn't)
 *   4. parseMemSearchURI handles the URI forms we promised to support
 *   5. renderSearchResultsAsMarkdown produces non-empty markdown when
 *      sections have data, and a "no matches" stub otherwise
 *
 * What this file does NOT cover: the backend integration of
 * resources/read for mem://profile and mem://search. Those call into
 * agent-sdk's getContext/searchMemory which hit the real /mem/* HTTP
 * endpoints — covering that requires a full HTTP mock server, which is
 * out of scope here. The runtime smoke is done on the user's Codex
 * machine after this lands.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let sdkAvailable = true;
try {
  require.resolve("@modelcontextprotocol/sdk/server/index.js");
  require.resolve("@modelcontextprotocol/sdk/client/index.js");
  require.resolve("@modelcontextprotocol/sdk/inMemory.js");
} catch {
  sdkAvailable = false;
}

describe("mcp resources surface", { skip: !sdkAvailable && "SDK not installed" }, () => {
  test("resources/list advertises mem://profile", async () => {
    process.env.EVERME_API_BASE = "http://127.0.0.1:0";
    process.env.EVERME_AGENT_ID = "agt_x";
    process.env.EVERME_AGENT_TOKEN = "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createMcpServer } = await import("../src/mcp.js");

    const { server, dispose } = createMcpServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(s), client.connect(c)]);

    try {
      const { resources } = await client.listResources();
      assert.ok(Array.isArray(resources) && resources.length >= 1,
        "resources/list must return at least one resource");
      const profile = resources.find((r) => r.uri === "mem://profile");
      assert.ok(profile, "mem://profile must be listed — Codex skill depends on this URI");
      assert.equal(profile.mimeType, "text/markdown",
        "mimeType drives how the host renders the read content; must be markdown so the LLM splices it into context as prose");
      assert.ok(profile.description && profile.description.length > 20,
        "description must explain WHEN to read this resource — Codex skills surface it to the model");
    } finally {
      await client.close();
      await server.close();
      await dispose();
    }
  });

  test("resources/templates/list advertises mem://search template", async () => {
    process.env.EVERME_API_BASE = "http://127.0.0.1:0";
    process.env.EVERME_AGENT_ID = "agt_x";
    process.env.EVERME_AGENT_TOKEN = "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createMcpServer } = await import("../src/mcp.js");

    const { server, dispose } = createMcpServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(s), client.connect(c)]);

    try {
      const { resourceTemplates } = await client.listResourceTemplates();
      assert.ok(Array.isArray(resourceTemplates) && resourceTemplates.length >= 1);
      const search = resourceTemplates.find((t) => t.uriTemplate.startsWith("mem://search"));
      assert.ok(search, "mem://search template must be advertised");
      assert.match(search.uriTemplate, /\{query\}/,
        "template must declare {query} placeholder for RFC 6570 expansion");
      assert.match(search.uriTemplate, /\{topK\}/,
        "template must declare {topK} placeholder — host may want to pin topK to a non-default");
    } finally {
      await client.close();
      await server.close();
      await dispose();
    }
  });

  test("resources/read on unknown URI fails loudly", async () => {
    process.env.EVERME_API_BASE = "http://127.0.0.1:0";
    process.env.EVERME_AGENT_ID = "agt_x";
    process.env.EVERME_AGENT_TOKEN = "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createMcpServer } = await import("../src/mcp.js");

    const { server, dispose } = createMcpServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(s), client.connect(c)]);

    try {
      await assert.rejects(
        () => client.readResource({ uri: "mem://nonsense" }),
        (err) => /unknown EverMe resource URI/i.test(err.message) || /unknown/i.test(err.message),
        "unknown URI must surface as a JSON-RPC error, not as a success with empty contents",
      );
    } finally {
      await client.close();
      await server.close();
      await dispose();
    }
  });

  test("resources/read on mem://search with empty q rejects", async () => {
    process.env.EVERME_API_BASE = "http://127.0.0.1:0";
    process.env.EVERME_AGENT_ID = "agt_x";
    process.env.EVERME_AGENT_TOKEN = "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createMcpServer } = await import("../src/mcp.js");

    const { server, dispose } = createMcpServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(s), client.connect(c)]);

    try {
      // Empty `q` would fire a meaningless semantic search. The handler
      // must reject rather than silently return zero matches — otherwise
      // a host that templated the URI wrong would see "no memories" and
      // mislead the user.
      await assert.rejects(
        () => client.readResource({ uri: "mem://search?q=" }),
        (err) => /non-empty 'q'/i.test(err.message) || /requires/i.test(err.message),
      );
    } finally {
      await client.close();
      await server.close();
      await dispose();
    }
  });
});

describe("parseMemSearchURI", { skip: !sdkAvailable && "SDK not installed" }, () => {
  test("parses q and topK from canonical form", async () => {
    const { parseMemSearchURI } = await import("../src/mcp.js");
    assert.deepEqual(parseMemSearchURI("mem://search?q=foo&topK=10"), { query: "foo", topK: 10 });
  });

  test("defaults topK to 5 when omitted", async () => {
    const { parseMemSearchURI } = await import("../src/mcp.js");
    assert.deepEqual(parseMemSearchURI("mem://search?q=foo"), { query: "foo", topK: 5 });
  });

  test("recovers from non-numeric topK rather than throwing", async () => {
    // LLM-templated URIs occasionally splice non-numeric values for
    // numeric params. Falling back to the default beats throwing —
    // the host would have to special-case the failure otherwise.
    const { parseMemSearchURI } = await import("../src/mcp.js");
    assert.deepEqual(parseMemSearchURI("mem://search?q=foo&topK=abc"), { query: "foo", topK: 5 });
  });

  test("rejects parseInt prefix-eating values like 1e2 / 5xyz (regression for #11/#12)", async () => {
    // parseInt('1e2', 10) === 1, parseInt('5xyz', 10) === 5 — the OLD
    // parser silently truncated these instead of falling back to
    // default, so `topK=1e2` (LLM scientific notation for 100) returned
    // 1 result. Strict ^\d+$ regex now rejects both forms.
    const { parseMemSearchURI } = await import("../src/mcp.js");
    assert.equal(parseMemSearchURI("mem://search?q=foo&topK=1e2").topK, 5,
      "topK=1e2 was silently truncated to 1; must fall back to default");
    assert.equal(parseMemSearchURI("mem://search?q=foo&topK=5xyz").topK, 5,
      "topK=5xyz was silently truncated to 5; must fall back to default");
  });

  test("clamps topK to the MEM_RESOURCE_TOPK_MAX ceiling", async () => {
    // Without an upper bound, mem://search?q=foo&topK=9999 fetches and
    // renders thousands of rows — easy way to blow past the host's MCP
    // content limit and the LLM context window. Cap is 50.
    const { parseMemSearchURI } = await import("../src/mcp.js");
    assert.equal(parseMemSearchURI("mem://search?q=foo&topK=9999").topK, 50,
      "topK=9999 must clamp to MEM_RESOURCE_TOPK_MAX=50");
  });

  test("uses caller-supplied defaultTopK instead of hard-coded 5", async () => {
    // When the handler calls parseMemSearchURI(uri, cfg.topK), Resources
    // and Tools surfaces return the same number of results for an
    // unqualified query. Without this, a deployment that customizes
    // cfg.topK=20 would see Tools return 20 but Resources return 5.
    const { parseMemSearchURI } = await import("../src/mcp.js");
    assert.equal(parseMemSearchURI("mem://search?q=foo", 20).topK, 20,
      "defaultTopK argument must override the hard-coded fallback");
    // Caller default also still clamps to the ceiling.
    assert.equal(parseMemSearchURI("mem://search?q=foo", 999).topK, 50,
      "even caller-supplied defaults clamp to MEM_RESOURCE_TOPK_MAX");
  });

  test("accepts both topK and top_k aliases", async () => {
    // Some hosts render snake_case by default. We accept either to keep
    // the URL ergonomics gentle on the LLM's templating mistakes.
    const { parseMemSearchURI } = await import("../src/mcp.js");
    assert.equal(parseMemSearchURI("mem://search?q=foo&top_k=3").topK, 3);
  });

  test("accepts query as alias for q", async () => {
    const { parseMemSearchURI } = await import("../src/mcp.js");
    assert.equal(parseMemSearchURI("mem://search?query=foo").query, "foo");
  });

  test("URL-decodes the query value", async () => {
    // RFC 6570 / URI percent-encoding — the URL searchParams getter
    // already decodes, but pin this so a future hand-rolled parser
    // can't regress.
    const { parseMemSearchURI } = await import("../src/mcp.js");
    assert.equal(
      parseMemSearchURI("mem://search?q=hello%20world%21").query,
      "hello world!",
    );
  });
});

describe("normalizeTopK (Tools-surface guard parallel to parseMemSearchURI)", { skip: !sdkAvailable && "SDK not installed" }, () => {
  // The Tools path (mem_search) previously used `args.topK ?? cfg.topK`,
  // which only falls back on null/undefined. A host LLM that templates
  // `{topK: 0}` (a common default-numeric mistake) used to send topK=0
  // straight through to /mem/search and get back an empty bundle that
  // looked identical to a real "no matching memories" miss. The
  // Resources path's parseMemSearchURI has always required `n > 0`;
  // normalizeTopK brings the Tools path to behavioral parity.

  test("falls back when value is 0", async () => {
    const { normalizeTopK } = await import("../src/mcp.js");
    assert.equal(normalizeTopK(0, 5), 5, "topK=0 must fall back — `??` would have let 0 through");
  });

  test("falls back when value is negative", async () => {
    const { normalizeTopK } = await import("../src/mcp.js");
    assert.equal(normalizeTopK(-3, 5), 5);
  });

  test("falls back on null and undefined (matches ?? semantics)", async () => {
    const { normalizeTopK } = await import("../src/mcp.js");
    assert.equal(normalizeTopK(null, 5), 5);
    assert.equal(normalizeTopK(undefined, 5), 5);
  });

  test("falls back on non-integer (NaN, floats, strings that don't parse)", async () => {
    const { normalizeTopK } = await import("../src/mcp.js");
    assert.equal(normalizeTopK(NaN, 5), 5);
    assert.equal(normalizeTopK(2.5, 5), 5, "fractional topK must not be silently floored");
    assert.equal(normalizeTopK("abc", 5), 5);
  });

  test("accepts positive integers and numeric strings", async () => {
    const { normalizeTopK } = await import("../src/mcp.js");
    assert.equal(normalizeTopK(10, 5), 10);
    assert.equal(normalizeTopK("10", 5), 10, "Number('10') is an integer; spec-compliant LLM JSON-numeric coercion");
  });

  test("clamps to MEM_RESOURCE_TOPK_MAX (50) by default", async () => {
    const { normalizeTopK } = await import("../src/mcp.js");
    assert.equal(normalizeTopK(9999, 5), 50, "must cap at 50 — same ceiling Resources path enforces");
  });
});

describe("renderSearchResultsAsMarkdown", { skip: !sdkAvailable && "SDK not installed" }, () => {
  // These tests use the REAL field shapes the EverMe /mem/search gateway
  // returns — verified against plugins/agent-sdk/src/prompt.js's
  // canonical formatRow / formatProfile / formatCase / formatRawMessage.
  //
  // An earlier version of the renderer hand-rolled a
  // `row.text || row.description || row.content || JSON.stringify(row)`
  // fallback chain that matched NO real backend shape — production
  // search reads on Codex were dumping wall-of-JSON to the LLM. The
  // renderer now delegates to agent-sdk's buildMemoryPrompt, which is
  // the single source of truth across MCP + OpenClaw + Hermes.

  test("renders memories using the real `episode` field", async () => {
    const { renderSearchResultsAsMarkdown } = await import("../src/mcp.js");
    const md = renderSearchResultsAsMarkdown("preferences", {
      memories: [{ type: "episodic_memory", episode: "User likes iced americano in the morning" }],
    });
    assert.match(md, /preferences/);
    assert.match(md, /### Episodic memory/);
    assert.match(md, /User likes iced americano/);
    // Guard against the old bug where `m.text` was the primary field —
    // if someone restores the old fallback chain, this assertion still
    // passes BUT the next test (raw messages) catches it.
  });

  test("renders profiles using profileData.embed_text (snake_case nested)", async () => {
    // EverMe gateway returns EverOS profileData verbatim, including its
    // snake_case keys. A renderer that looks at `p.text` or
    // `p.description` finds nothing and emits "[object Object]" or
    // empty rows.
    const { renderSearchResultsAsMarkdown } = await import("../src/mcp.js");
    const md = renderSearchResultsAsMarkdown("color", {
      profiles: [{ profileData: { embed_text: "Preferences: red over deep blue", item_type: "Preferences" } }],
    });
    assert.match(md, /### User profile/);
    assert.match(md, /\[Preferences\]/, "item_type should become the label tag");
    assert.match(md, /red over deep blue/);
  });

  test("renders rawMessages by unwrapping contentItems array (the original [object Object] regression)", async () => {
    // This is the bug that motivated the renderer rewrite. /mem/search
    // returns rawMessages whose `contentItems` is an opaque parts array
    // (text + tool_use + attachments). The old renderer did
    // `String(arrayOfParts).slice(...)` and produced
    // `[object Object],[object Object]` literally in the LLM context.
    const { renderSearchResultsAsMarkdown } = await import("../src/mcp.js");
    const md = renderSearchResultsAsMarkdown("debug", {
      rawMessages: [{
        senderName: "assistant",
        contentItems: [
          { type: "text", text: "I think the bug is in the marketplace add path" },
          { type: "tool_use", id: "x", name: "exec", input: { cmd: "ls" } },
        ],
      }],
    });
    assert.match(md, /### Recent raw messages/);
    assert.match(md, /I think the bug is in the marketplace add path/);
    assert.doesNotMatch(md, /\[object Object\]/,
      "array contentItems must be unwrapped, not String()-coerced — this is the original A.3 regression");
  });

  test("renders agent cases using taskIntent field", async () => {
    const { renderSearchResultsAsMarkdown } = await import("../src/mcp.js");
    const md = renderSearchResultsAsMarkdown("install", {
      agentMemory: {
        cases: [{ taskIntent: "Diagnose Codex MCP not loading after install", approach: "Restart Codex App, then re-run plugin install" }],
        skills: [],
      },
    });
    assert.match(md, /### Past task cases/);
    assert.match(md, /Diagnose Codex MCP/);
  });

  test("emits a 'no matches' marker when every section is empty", async () => {
    const { renderSearchResultsAsMarkdown } = await import("../src/mcp.js");
    const md = renderSearchResultsAsMarkdown("kyoto", {
      memories: [], profiles: [], rawMessages: [], agentMemory: { cases: [], skills: [] },
    });
    assert.match(md, /no matching memories/i,
      "host LLMs need a clear 'nothing found' signal — empty markdown looks like a backend bug");
  });

  test("rows are bounded in length (oneLine truncation at ~280 chars)", async () => {
    const { renderSearchResultsAsMarkdown } = await import("../src/mcp.js");
    const huge = "x".repeat(2000);
    const md = renderSearchResultsAsMarkdown("q", { memories: [{ type: "episodic_memory", episode: huge }] });
    // buildMemoryPrompt's oneLine() caps each row at 280 chars.
    // Pin a generous upper bound so a future cap change doesn't bloat
    // the LLM context window unnoticed.
    assert.ok(md.length < 500, `rendered length=${md.length} exceeded budget — long rows must be truncated`);
  });
});

describe("resources/read URI routing (URL.host based)", { skip: !sdkAvailable && "SDK not installed" }, () => {
  // The handler routes by `new URL(uri).host` instead of string match
  // so benign variants (trailing slash, cache-bust querystring) hit
  // the right resource, AND false positives like `mem://searchfoo` get
  // a clean 'unknown resource' error instead of the wrong handler.

  test("mem://profile/ (trailing slash) resolves the same as mem://profile", async () => {
    // `new URL('mem://profile/').host === 'profile'` so both variants
    // converge on the profile branch. Strict-equality matching would
    // have rejected the trailing-slash form.
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    process.env.EVERME_API_BASE = "http://127.0.0.1:0";
    process.env.EVERME_AGENT_ID = "agt_x";
    process.env.EVERME_AGENT_TOKEN = "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { createMcpServer } = await import("../src/mcp.js");
    const { server, dispose } = createMcpServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(s), client.connect(c)]);
    try {
      // The backend isn't reachable (port 0) so the read will fail at
      // the HTTP layer — but the error must reflect "tried to call
      // /mem/context", NOT "unknown EverMe resource URI". That's how
      // we verify routing chose the profile branch.
      await assert.rejects(
        () => client.readResource({ uri: "mem://profile/" }),
        (err) => {
          assert.doesNotMatch(err.message, /unknown EverMe resource URI/i,
            "mem://profile/ must route to the profile handler, not fall through to unknown-URI");
          return true;
        },
      );
    } finally {
      await client.close();
      await server.close();
      await dispose();
    }
  });

  test("mem://searchfoo is rejected as unknown — startsWith bug would have accepted it", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    process.env.EVERME_API_BASE = "http://127.0.0.1:0";
    process.env.EVERME_AGENT_ID = "agt_x";
    process.env.EVERME_AGENT_TOKEN = "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { createMcpServer } = await import("../src/mcp.js");
    const { server, dispose } = createMcpServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(s), client.connect(c)]);
    try {
      await assert.rejects(
        () => client.readResource({ uri: "mem://searchfoo?q=hi" }),
        (err) => /unknown EverMe resource URI/i.test(err.message),
        "mem://searchfoo must be rejected as unknown; the previous startsWith('mem://search') bug accepted it",
      );
    } finally {
      await client.close();
      await server.close();
      await dispose();
    }
  });

  test("malformed URI surfaces a structured 'malformed' error, not a bare TypeError", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    process.env.EVERME_API_BASE = "http://127.0.0.1:0";
    process.env.EVERME_AGENT_ID = "agt_x";
    process.env.EVERME_AGENT_TOKEN = "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { createMcpServer } = await import("../src/mcp.js");
    const { server, dispose } = createMcpServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(s), client.connect(c)]);
    try {
      await assert.rejects(
        () => client.readResource({ uri: "not a valid uri at all" }),
        (err) => /malformed EverMe resource URI/i.test(err.message),
      );
    } finally {
      await client.close();
      await server.close();
      await dispose();
    }
  });
});

describe("mem://profile redaction (handler-level, with HTTP mock)", { skip: !sdkAvailable && "SDK not installed" }, () => {
  // #2 in the code review: the resources/read success path must scrub
  // evt_/emk_ tokens via redactError before returning content to the
  // host. The earlier test only exercised redactError in isolation —
  // it didn't catch a regression that removed the redactError() call
  // from the handler. This test wires a real HTTP mock as the EverMe
  // backend, returns a profile string with a leaked evt_ token, and
  // asserts the response text is scrubbed end-to-end.

  test("evt_* tokens in /mem/context response are scrubbed before reaching the client", async () => {
    const http = await import("node:http");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

    // Spin up a tiny HTTP server that mocks /api/v1/mem/context.
    // The returned `context` string contains an evt_ token literal —
    // the handler must call redactError() on it before returning.
    const leakedToken = "evt_deadbeefdeadbeefdeadbeefdeadbeef";
    const profileWithLeak = `## Relevant memory\n- [Preferences] iced americano\n- LEAKED: ${leakedToken} (oops, the user once pasted this)`;

    const mockServer = http.createServer((req, res) => {
      if (req.url === "/api/v1/mem/context" && req.method === "POST") {
        // Drain body
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          // EverMe envelope per agent-sdk/src/client.js:7 —
          // `{ error, requestId, status, result }` with status===0
          // meaning success. result carries the actual /mem/context
          // payload (context + memoryCount).
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            status: 0,
            requestId: "req-mock",
            error: "",
            result: { context: profileWithLeak, memoryCount: 2 },
          }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    const port = mockServer.address().port;

    process.env.EVERME_API_BASE = `http://127.0.0.1:${port}`;
    process.env.EVERME_AGENT_ID = "agt_x";
    process.env.EVERME_AGENT_TOKEN = "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { createMcpServer } = await import("../src/mcp.js");
    const { server, dispose } = createMcpServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(s), client.connect(c)]);

    try {
      const result = await client.readResource({ uri: "mem://profile" });
      const text = result.contents[0].text;
      assert.match(text, /iced americano/, "non-secret content must survive scrub intact");
      assert.doesNotMatch(text, new RegExp(leakedToken),
        `the leaked literal evt_ token must be scrubbed before reaching the host (regression of #2 — removing redactError() from the handler would make this assertion fail)`);
    } finally {
      await client.close();
      await server.close();
      await dispose();
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });
});

describe("mem_context / mem_search tools return raw markdown (no JSON envelope)", { skip: !sdkAvailable && "SDK not installed" }, () => {
  // Earlier versions of this server JSON.stringify'd the entire
  // getContext / searchMemory bundle into the tool result. The host LLM
  // then saw `{"context": "## Relevant memory\\n- [Preferences]..."}`
  // instead of clean markdown, wasting tokens and forcing it to peel
  // a JSON envelope every time. These tests pin that the Tools path
  // returns the SAME shape as the Resources path: contents[0].text is
  // markdown verbatim, not a stringified JSON object.

  test("mem_context returns raw markdown, not a JSON envelope", async () => {
    const http = await import("node:http");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

    const profileMarkdown = "## Relevant memory\n- [Preferences] iced americano in the morning";

    const mockServer = http.createServer((req, res) => {
      if (req.url === "/api/v1/mem/context" && req.method === "POST") {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            status: 0,
            requestId: "req-mock",
            error: "",
            result: { context: profileMarkdown, memoryCount: 1 },
          }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    const port = mockServer.address().port;

    process.env.EVERME_API_BASE = `http://127.0.0.1:${port}`;
    process.env.EVERME_AGENT_ID = "agt_x";
    process.env.EVERME_AGENT_TOKEN = "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { createMcpServer } = await import("../src/mcp.js");
    const { server, dispose } = createMcpServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(s), client.connect(c)]);

    try {
      const result = await client.callTool({ name: "mem_context", arguments: { query: "morning routine" } });
      const text = result.content[0].text;
      assert.equal(text, profileMarkdown,
        "mem_context must return the markdown verbatim — wrapping it as " +
        "JSON.stringify({context, memoryCount}) forces the LLM to peel an " +
        "envelope and wastes tokens on every recall.");
      // Guard against accidental JSON wrapping: a JSON envelope would
      // start with `{` and contain the escaped newline `\\n`.
      assert.ok(!text.startsWith("{"),
        "tool result text must not start with { — that indicates JSON.stringify wrapping is back");
      assert.ok(!text.includes('"context":'),
        'tool result text must not contain the literal "context": JSON key');
    } finally {
      await client.close();
      await server.close();
      await dispose();
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  test("mem_search returns rendered markdown sections, not JSON.stringify of the bundle", async () => {
    const http = await import("node:http");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

    // Mock /mem/search to return a bundle with one episodic memory.
    // The handler must run it through buildMemoryPrompt (same renderer
    // as the Resources path) so the host LLM sees natural-language
    // bullets, not raw field names like "embed_text" or "episode".
    const mockServer = http.createServer((req, res) => {
      if (req.url === "/api/v1/mem/search" && req.method === "POST") {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          // Wire shape: backend returns `items` (with parallel
          // profiles/rawMessages/agentMemory). agent-sdk's searchMemory
          // rebrands `items` → `memories` at the SDK boundary, so
          // mocking `memories` here would silently return nothing —
          // buildMemoryPrompt reads from bundle.memories which is
          // populated only from result.items.
          res.end(JSON.stringify({
            status: 0,
            requestId: "req-mock",
            error: "",
            result: {
              items: [{ episode: "User mentioned they like durian." }],
              profiles: [],
              rawMessages: [],
              agentMemory: { cases: [], skills: [] },
            },
          }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    const port = mockServer.address().port;

    process.env.EVERME_API_BASE = `http://127.0.0.1:${port}`;
    process.env.EVERME_AGENT_ID = "agt_x";
    process.env.EVERME_AGENT_TOKEN = "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { createMcpServer } = await import("../src/mcp.js");
    const { server, dispose } = createMcpServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(s), client.connect(c)]);

    try {
      const result = await client.callTool({ name: "mem_search", arguments: { query: "durian" } });
      const text = result.content[0].text;
      assert.match(text, /^## EverMe search results for "durian"/,
        "mem_search markdown must lead with the query header — same as the Resources path");
      assert.match(text, /User mentioned they like durian/,
        "episodic memory body must be surfaced (via buildMemoryPrompt) — not the raw field name");
      assert.ok(!text.startsWith("{"),
        "tool result text must not start with { — that indicates JSON.stringify wrapping is back");
      assert.ok(!text.includes('"memories":'),
        'tool result must not contain the literal "memories": JSON key from the searchMemory bundle');
    } finally {
      await client.close();
      await server.close();
      await dispose();
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });
});

describe("mem_save_fact dispatch (profile write path)", { skip: !sdkAvailable && "SDK not installed" }, () => {
  // mem_save_fact must hit /mem/personal (profile + episodic), NOT
  // /mem/agent-memory (case/skill). Routing it to the agent path would
  // silently reproduce the very bug this tool exists to fix: a stated
  // user preference that never reaches the profile block.
  test("`fact` shorthand posts a single user message to /mem/personal", async () => {
    const http = await import("node:http");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

    let captured = null;
    const mockServer = http.createServer((req, res) => {
      if (req.url === "/api/v1/mem/personal" && req.method === "POST") {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          captured = JSON.parse(Buffer.concat(chunks).toString());
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            status: 0,
            requestId: "req-mock",
            error: "",
            result: { status: "no_extraction", messageCount: captured.messages.length, flushed: true, extracted: false },
          }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    const port = mockServer.address().port;

    process.env.EVERME_API_BASE = `http://127.0.0.1:${port}`;
    process.env.EVERME_AGENT_ID = "agt_x";
    process.env.EVERME_AGENT_TOKEN = "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { createMcpServer } = await import("../src/mcp.js");
    const { server, dispose } = createMcpServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(s), client.connect(c)]);

    try {
      const result = await client.callTool({ name: "mem_save_fact", arguments: { fact: "I love summer" } });
      assert.ok(captured, "the personal endpoint must have been hit — mem_save_fact routed elsewhere otherwise");
      assert.equal(captured.messages.length, 1);
      assert.equal(captured.messages[0].role, "user");
      assert.equal(captured.messages[0].content, "I love summer");
      assert.equal(captured.flush, true, "flush defaults to true");
      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.saved, true);
      // The tool passes through EverOS's real extraction verdict. This is
      // success-shaped but NOT a profile update.
      assert.equal(parsed.status, "no_extraction");
      assert.equal(parsed.flushed, true);
      assert.equal(parsed.extracted, false);

      // A stray tool-role message must be REJECTED with an error — never
      // silently rewritten into a user-attributed profile fact — and the
      // backend must not be hit at all.
      captured = null;
      const bad = await client.callTool({
        name: "mem_save_fact",
        arguments: {
          messages: [
            { role: "user", content: "I take my coffee iced" },
            { role: "tool", content: "tool output that must not become a fact" },
          ],
        },
      });
      assert.equal(bad.isError, true, "an invalid role must produce an error response");
      assert.equal(captured, null, "the backend must not be hit when any role is invalid");
    } finally {
      await client.close();
      await server.close();
      await dispose();
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });
});

describe("EVERME_MCP_INSTRUCTIONS resources hint", { skip: !sdkAvailable && "SDK not installed" }, () => {
  test("instructions mention both URIs so Codex-like hosts can self-discover", async () => {
    const { EVERME_MCP_INSTRUCTIONS } = await import("../src/mcp.js");
    assert.match(EVERME_MCP_INSTRUCTIONS, /mem:\/\/profile/,
      "instructions must reference mem://profile so hosts reading instructions know the recall URI");
    assert.match(EVERME_MCP_INSTRUCTIONS, /mem:\/\/search/,
      "instructions must reference mem://search so hosts know the query URI");
  });
});
