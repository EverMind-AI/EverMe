import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { searchMemory, QUERY_MAX_CHARS } from "../src/search.js";

describe("searchMemory", () => {
  test("posts query + topK to /mem/search and renames items → memories", async () => {
    const calls = [];
    const client = {
      async request(method, path, body) {
        calls.push({ method, path, body });
        return { items: [{ summary: "hit" }], profiles: [], requestId: "req-1" };
      },
    };

    const res = await searchMemory(client, { query: "what do I prefer", topK: 3 });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].path, "/mem/search");
    assert.equal(calls[0].body.query, "what do I prefer");
    assert.equal(calls[0].body.topK, 3);
    assert.equal(res.memories.length, 1);
    assert.equal(res.requestId, "req-1");
  });

  test("clamps an over-long query to the backend's MaxSearchQueryRunes", async () => {
    // The backend rejects query > 1024 runes; the SDK is the single
    // chokepoint to /mem/search, so an oversized prompt from any caller
    // (hook / OpenClaw / MCP) must be truncated here, not 422'd upstream.
    let sent = null;
    const client = {
      async request(_m, _p, body) {
        sent = body;
        return { items: [] };
      },
    };
    const huge = "x".repeat(5000);
    await searchMemory(client, { query: huge });

    assert.equal(sent.query.length, QUERY_MAX_CHARS, "query capped at QUERY_MAX_CHARS");
    assert.ok(sent.query.length <= 1024, "must not exceed the backend rune limit");
    assert.equal(sent.query, huge.slice(0, QUERY_MAX_CHARS));
  });

  test("a query within the limit is sent unchanged", async () => {
    let sent = null;
    const client = { async request(_m, _p, body) { sent = body; return { items: [] }; } };
    const ok = "y".repeat(1024);
    await searchMemory(client, { query: ok });
    assert.equal(sent.query, ok, "exactly-at-limit query is untouched");
  });
});
