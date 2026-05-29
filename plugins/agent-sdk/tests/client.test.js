import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createClient, EvermeError } from "../src/client.js";

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

  test("query params are appended", async (t) => {
    t.after(async () => s.close());
    const c = createClient({ baseUrl: s.baseUrl, agentId: "x", agentToken: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    await c.request("GET", "/agents", undefined, { query: { platform: "claude-code" } });
    assert.equal(s.getLastRequest().url, "/agents?platform=claude-code");
  });
});
