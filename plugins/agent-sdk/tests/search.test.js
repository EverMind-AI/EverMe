import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { searchMemory, QUERY_MAX_CHARS, buildTimestampFilter, normalizeInstant } from "../src/search.js";

describe("searchMemory", () => {
  test("posts query + topK to /mem/search and renames items → memories", async () => {
    const calls = [];
    // requestWithMeta mirrors the real client contract: the trace id lives on
    // the envelope, NOT inside result — a result-level requestId used to mask
    // the fact that searchMemory read a field the backend never sent there.
    const client = {
      async requestWithMeta(method, path, body) {
        calls.push({ method, path, body });
        return { result: { items: [{ summary: "hit" }], profiles: [] }, requestId: "req-1" };
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

  test("uses topK=10 when callers omit it", async () => {
    let sent;
    const client = { async request(_method, _path, body) { sent = body; return { items: [] }; } };
    await searchMemory(client, { query: "default recall" });
    assert.equal(sent.topK, 10);
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

  test("logs only bounded query metadata and result counts", async () => {
    const lines = [];
    const query = "private search text";
    const client = {
      async requestWithMeta() {
        return {
          result: { items: [{ id: "m1" }], profiles: [{ id: "p1" }] },
          requestId: `req-${"x".repeat(300)}`,
        };
      },
    };

    await searchMemory(client, { query }, { info: (line) => lines.push(line) });

    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes(query));
    assert.ok(lines[0].includes(`queryChars=${query.length}`));
    assert.ok(lines[0].includes("memories=1 profiles=1"));
    assert.ok(lines[0].length < 400);
  });
});

// Read normalizeInstant back out of a child process pinned to a known TZ.
// Node resolves the host zone once at startup, so an in-process
// process.env.TZ assignment would not move Intl — the only honest way to
// prove "bare date means the user's local day, not UTC's" is a fresh process.
function normalizeInZone(tz, value) {
  const modulePath = fileURLToPath(new URL("../src/search.js", import.meta.url));
  const script = `import("${modulePath}").then((m) => process.stdout.write(m.normalizeInstant(${JSON.stringify(value)})));`;
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, TZ: tz },
    encoding: "utf8",
  });
}

describe("searchMemory filters", () => {
  test("narrowing goes out as `filters` (plural) — the field the gateway reads", async () => {
    // This used to be sent as `filter`, which Go dropped as an unknown field.
    // Every narrowing the plugins tried to pass was silently discarded.
    let sent = null;
    const client = { async request(_m, _p, body) { sent = body; return { items: [] }; } };
    const filters = buildTimestampFilter({ startTime: "2026-09-09", endTime: "2026-09-09T23:59:59" });

    await searchMemory(client, { query: "bug fixes", filters });

    assert.deepEqual(sent.filters, filters);
    assert.equal(sent.filter, undefined, "the singular spelling must be gone");
  });

  test("with no bounds the request body carries no `filters` key at all", async () => {
    let sent = null;
    const client = { async request(_m, _p, body) { sent = body; return { items: [] }; } };

    await searchMemory(client, { query: "unit test framework", filters: buildTimestampFilter({}) });

    assert.ok(!("filters" in sent), "an unfiltered search must not send an empty filters object");
    assert.deepEqual(Object.keys(sent).sort(), ["query", "topK"]);
  });
});

describe("buildTimestampFilter", () => {
  test("a lone startTime is a legal open interval — gte only, no lte", () => {
    const filters = buildTimestampFilter({ startTime: "2026-09-01T00:00:00+08:00" });
    assert.deepEqual(filters, { timestamp: { gte: "2026-09-01T00:00:00+08:00" } });
  });

  test("a lone endTime is a legal open interval — lte only, no gte", () => {
    const filters = buildTimestampFilter({ endTime: "2026-08-20T23:59:59+08:00" });
    assert.deepEqual(filters, { timestamp: { lte: "2026-08-20T23:59:59+08:00" } });
  });

  test("a reversed interval throws instead of silently filtering to nothing", () => {
    // Silently returning zero rows is the worst outcome: the model cannot
    // tell an empty window from a topic that was never discussed.
    assert.throws(
      () => buildTimestampFilter({
        startTime: "2026-09-10T00:00:00+08:00",
        endTime: "2026-09-09T00:00:00+08:00",
      }),
      RangeError,
    );
  });

  test("bounds are ordered by instant, not lexically", () => {
    // 2026-09-09T01:00:00+08:00 is EARLIER than 2026-09-08T20:00:00Z, even
    // though it sorts later as a string. Comparing text would reject a
    // perfectly valid window whose two ends carry different offsets.
    assert.doesNotThrow(() => buildTimestampFilter({
      startTime: "2026-09-08T18:00:00Z",
      endTime: "2026-09-09T09:00:00+08:00",
    }));
  });

  test("an unparseable bound throws rather than reaching the gateway", () => {
    assert.throws(() => buildTimestampFilter({ startTime: "yesterday" }), RangeError);
    assert.throws(() => buildTimestampFilter({ startTime: "2026-02-30" }), RangeError);
  });

  test("neither bound compiles to null, so no filters key is built at all", () => {
    assert.equal(buildTimestampFilter({}), null);
    assert.equal(buildTimestampFilter(), null);
    assert.equal(buildTimestampFilter({ startTime: "", endTime: "   " }), null);
  });
});

describe("normalizeInstant", () => {
  test("an explicit offset is kept verbatim", () => {
    assert.equal(normalizeInstant("2026-09-09T00:00:00Z"), "2026-09-09T00:00:00Z");
    assert.equal(normalizeInstant("2026-09-09T00:00:00+08:00"), "2026-09-09T00:00:00+08:00");
    assert.equal(normalizeInstant("2026-09-09T00:00:00.500-05:00"), "2026-09-09T00:00:00.500-05:00");
  });

  test("a bare date is completed in the given zone, midnight local", () => {
    assert.equal(normalizeInstant("2026-09-09", "Asia/Shanghai"), "2026-09-09T00:00:00+08:00");
    assert.equal(normalizeInstant("2026-09-09 14:30", "Asia/Shanghai"), "2026-09-09T14:30:00+08:00");
    assert.equal(normalizeInstant("2026-09-09T23:59:59", "Asia/Shanghai"), "2026-09-09T23:59:59+08:00");
  });

  test("the zone's offset is read at that instant, so DST is respected", () => {
    assert.equal(normalizeInstant("2026-09-09", "America/New_York"), "2026-09-09T00:00:00-04:00");
    assert.equal(normalizeInstant("2026-01-09", "America/New_York"), "2026-01-09T00:00:00-05:00");
  });

  test("with no zone argument a bare date follows the host, not UTC", () => {
    assert.equal(normalizeInZone("Asia/Shanghai", "2026-09-09"), "2026-09-09T00:00:00+08:00");
    assert.equal(normalizeInZone("America/New_York", "2026-09-09"), "2026-09-09T00:00:00-04:00");
    assert.equal(normalizeInZone("UTC", "2026-09-09"), "2026-09-09T00:00:00+00:00");
  });

  test("empty input yields empty, never a bogus bound", () => {
    assert.equal(normalizeInstant(""), "");
    assert.equal(normalizeInstant(null), "");
    assert.equal(normalizeInstant("   "), "");
  });
});
