import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createClient, EvermeError, redactError } from "../src/client.js";

/**
 * Helper: spin up a tiny HTTP server, return its base URL + a
 * "respond" closure tests can use to set the next reply.
 */
function startServer() {
  let nextReply = { status: 200, body: { error: "ok", status: 0, result: {}, requestId: "req-1" } };
  let lastReq = null;

  const srv = http.createServer((req, res) => {
    let chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      lastReq = {
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: chunks.length ? Buffer.concat(chunks).toString() : "",
      };
      const r = nextReply;
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
    });
  });

  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        setReply: (r) => (nextReply = r),
        getLastRequest: () => lastReq,
        close: () => new Promise((res) => srv.close(res)),
      });
    });
  });
}

describe("client", () => {
  let s;
  beforeEach(async () => {
    s = await startServer();
  });

  test("attaches Bearer header from cfg.agentToken", async (t) => {
    t.after(async () => s.close());
    const c = createClient({
      baseUrl: s.baseUrl,
      agentId: "agt_x",
      agentToken: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    await c.request("GET", "/healthz");
    const req = s.getLastRequest();
    assert.match(req.headers.authorization, /^Bearer evt_/);
  });

  test("decodes envelope status===0 as success", async (t) => {
    t.after(async () => s.close());
    s.setReply({
      status: 200,
      body: { error: "ok", status: 0, result: { hello: "world" }, requestId: "r" },
    });
    const c = createClient({ baseUrl: s.baseUrl, agentId: "x", agentToken: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    const out = await c.request("POST", "/x", {});
    assert.deepEqual(out, { hello: "world" });
  });

  test("envelope status>0 throws EvermeError with code/requestId", async (t) => {
    t.after(async () => s.close());
    s.setReply({
      status: 200,
      body: { error: "ErrApiKeyInvalid", status: 30201, requestId: "r-42" },
    });
    const c = createClient({ baseUrl: s.baseUrl, agentId: "x", agentToken: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    await assert.rejects(
      c.request("POST", "/x", {}),
      (err) =>
        err instanceof EvermeError &&
        err.code === 30201 &&
        err.requestId === "r-42" &&
        err.type === "auth",
    );
  });

  test("non-JSON HTTP error becomes upstream EvermeError", async (t) => {
    t.after(async () => s.close());
    s.setReply({ status: 502, body: "<html>bad gateway</html>" });
    const c = createClient({ baseUrl: s.baseUrl, agentId: "x", agentToken: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    await assert.rejects(c.request("GET", "/x"), (err) => err instanceof EvermeError && err.httpStatus === 502);
  });

  test("token leak in error message is redacted", async (t) => {
    t.after(async () => s.close());
    // Some upstream sends the token back in an error body — defense in depth.
    s.setReply({
      status: 200,
      body: { error: "rejected: evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", status: 30001 },
    });
    const c = createClient({ baseUrl: s.baseUrl, agentId: "x", agentToken: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    try {
      await c.request("POST", "/x", {});
      assert.fail("expected throw");
    } catch (err) {
      assert.doesNotMatch(err.message, /evt_[a-f0-9]{32}/, "must not surface a full evt token");
      assert.match(err.message, /evt_aaaa_REDACTED/);
    }
  });

  test("redactError masks non-32-char and hyphenated evt_/emk_ tokens", async (t) => {
    t.after(async () => s.close());
    const hyphen = "evt_abcdefghij-klmnopqrs"; // 20+ with hyphen, used to leak
    const shortish = "emk_" + "A".repeat(20);
    const long = "evt_" + "b".repeat(40);
    const got = redactError(`leaked ${hyphen} and ${shortish} and ${long}`);
    assert.equal(got.includes(hyphen), false);
    assert.equal(got.includes(shortish), false);
    assert.equal(got.includes(long), false);
    assert.match(got, /evt_abcd_REDACTED/);
    assert.match(got, /emk_AAAA_REDACTED/);
  });

  test("query params are appended", async (t) => {
    t.after(async () => s.close());
    const c = createClient({ baseUrl: s.baseUrl, agentId: "x", agentToken: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    await c.request("GET", "/agents", undefined, { query: { platform: "claude-code" } });
    assert.equal(s.getLastRequest().url, "/agents?platform=claude-code");
  });
});

describe("request id propagation", () => {
  test("sends a requestId header and returns it via requestWithMeta", async () => {
    const srv = await startServer();
    try {
      srv.setReply({ status: 200, body: { error: "ok", status: 0, result: { ok: 1 }, requestId: "" } });
      const client = createClient({ baseUrl: srv.baseUrl, agentToken: "evt_x", agentId: "agt_1" });
      const { result, requestId } = await client.requestWithMeta("POST", "/mem/search", { query: "q" });
      assert.deepEqual(result, { ok: 1 });
      const sent = srv.getLastRequest().headers.requestid;
      assert.ok(sent, "requestId header must be sent");
      assert.equal(requestId, sent, "with no envelope id, the client-generated id is returned");
    } finally {
      await srv.close();
    }
  });

  test("prefers the envelope requestId and echoes it on errors and describe()", async () => {
    const srv = await startServer();
    try {
      srv.setReply({ status: 503, body: { error: "Memory profile temporarily unavailable", status: 50301, requestId: "srv-9" } });
      const client = createClient({ baseUrl: srv.baseUrl, agentToken: "evt_x", agentId: "agt_1" });
      await assert.rejects(
        () => client.requestWithMeta("POST", "/mem/agent-memory", {}),
        (err) => {
          assert.ok(err instanceof EvermeError);
          assert.equal(err.code, 50301);
          assert.equal(err.requestId, "srv-9");
          assert.match(err.describe(), /errno=50301/);
          assert.match(err.describe(), /requestId=srv-9/);
          return true;
        },
      );
    } finally {
      await srv.close();
    }
  });

  test("transport-level failures still carry the client-generated id", async () => {
    // Point at a port that is not listening: fetch rejects before any
    // response exists, so only the locally generated id can identify the
    // attempt in logs.
    const client = createClient({ baseUrl: "http://127.0.0.1:1", agentToken: "evt_x", agentId: "agt_1" });
    await assert.rejects(
      () => client.requestWithMeta("POST", "/mem/search", {}),
      (err) => {
        assert.ok(err instanceof EvermeError);
        assert.ok(err.requestId, "requestId must be set even without a response");
        return true;
      },
    );
  });
});
