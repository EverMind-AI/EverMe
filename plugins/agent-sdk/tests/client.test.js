import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createClient, EvermeError } from "../src/client.js";

const token = "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function successResponse(result = { ok: true }) {
  return jsonResponse({ error: "ok", status: 0, result, requestId: "req-ok" });
}

function fetchFailure(code, message = "fetch failed") {
  const err = new TypeError(message);
  err.cause = Object.assign(new Error("internal transport detail must stay private"), { code });
  return err;
}

function clientWithFetch(fetchImpl) {
  return createClient({
    baseUrl: "https://gateway.invalid/api/v1",
    agentId: "agt_test",
    agentToken: token,
    fetch: fetchImpl,
  });
}

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

  test("retries a safe GET once after a socket reset", async (t) => {
    t.after(async () => s.close());
    let calls = 0;
    const c = clientWithFetch(async () => {
      calls += 1;
      if (calls === 1) throw fetchFailure("ECONNRESET");
      return successResponse({ recovered: true });
    });

    const out = await c.request("GET", "/healthz");

    assert.deepEqual(out, { recovered: true });
    assert.equal(calls, 2);
  });

  test("retries an explicitly safe POST read once after a transport failure", async (t) => {
    t.after(async () => s.close());
    let calls = 0;
    const c = clientWithFetch(async () => {
      calls += 1;
      if (calls === 1) throw fetchFailure("UND_ERR_SOCKET");
      return successResponse({ items: [] });
    });

    const out = await c.request("POST", "/mem/search", { query: "q" }, {
      requestSemantics: "safe_read",
    });

    assert.deepEqual(out, { items: [] });
    assert.equal(calls, 2);
  });

  test("never retries a non-idempotent write, even if a caller mislabels it", async (t) => {
    t.after(async () => s.close());
    let calls = 0;
    const c = clientWithFetch(async () => {
      calls += 1;
      throw fetchFailure("ECONNRESET");
    });

    await assert.rejects(
      c.request("POST", "/mem/agent-memory", { messages: [] }, {
        requestSemantics: "safe_read",
      }),
      (err) => err instanceof EvermeError && err.attempts === 1,
    );
    assert.equal(calls, 1);
  });

  test("returns structured redacted metadata after DNS retries are exhausted", async (t) => {
    t.after(async () => s.close());
    let calls = 0;
    const c = clientWithFetch(async () => {
      calls += 1;
      throw fetchFailure("ENOTFOUND", "fetch failed");
    });

    await assert.rejects(c.request("GET", "/healthz"), (err) => {
      assert.ok(err instanceof EvermeError);
      assert.equal(err.classification, "transport");
      assert.equal(err.causeCode, "ENOTFOUND");
      assert.equal(err.attempts, 2);
      assert.equal(err.retryable, true);
      assert.equal(typeof err.elapsedMs, "number");
      assert.doesNotMatch(JSON.stringify(err), /internal transport detail/);
      return true;
    });
    assert.equal(calls, 2);
  });

  test("keeps a timeout inside one shared budget and reports it without a retry storm", async (t) => {
    t.after(async () => s.close());
    let calls = 0;
    const c = clientWithFetch((_url, { signal }) => {
      calls += 1;
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        }, { once: true });
      });
    });

    const startedAt = Date.now();
    await assert.rejects(
      c.request("GET", "/slow", undefined, { timeoutMs: 25 }),
      (err) =>
        err instanceof EvermeError &&
        err.classification === "timeout" &&
        err.causeCode === "TIMEOUT" &&
        err.attempts === 1 &&
        err.retryable === true,
    );
    assert.equal(calls, 1);
    assert.ok(Date.now() - startedAt < 250, "timeout retry budget must stay bounded");
  });

  test("retries a safe read once on HTTP 429", async (t) => {
    t.after(async () => s.close());
    let calls = 0;
    const c = clientWithFetch(async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(
          { error: "rate limited", status: 42900, requestId: "req-rate" },
          429,
          { "Retry-After": "0" },
        );
      }
      return successResponse({ recovered: true });
    });

    const out = await c.request("POST", "/mem/context", {}, {
      requestSemantics: "safe_read",
    });
    assert.deepEqual(out, { recovered: true });
    assert.equal(calls, 2);
  });

  test("retries a safe read once on HTTP 5xx", async (t) => {
    t.after(async () => s.close());
    let calls = 0;
    const c = clientWithFetch(async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({ error: "unavailable", status: 0, requestId: "req-503" }, 503);
      }
      return successResponse({ recovered: true });
    });

    const out = await c.request("GET", "/healthz");
    assert.deepEqual(out, { recovered: true });
    assert.equal(calls, 2);
  });

  test("does not retry HTTP 401 and preserves the request id", async (t) => {
    t.after(async () => s.close());
    let calls = 0;
    const c = clientWithFetch(async () => {
      calls += 1;
      return jsonResponse(
        { error: "invalid token", status: 30001, requestId: "req-auth" },
        401,
      );
    });

    await assert.rejects(c.request("GET", "/healthz"), (err) => {
      assert.ok(err instanceof EvermeError);
      assert.equal(err.type, "auth");
      assert.equal(err.classification, "auth");
      assert.equal(err.requestId, "req-auth");
      assert.equal(err.attempts, 1);
      assert.equal(err.retryable, false);
      return true;
    });
    assert.equal(calls, 1);
  });

  test("preserves envelope auth classification on non-401 HTTP errors", async (t) => {
    t.after(async () => s.close());
    let calls = 0;
    const c = clientWithFetch(async () => {
      calls += 1;
      return jsonResponse(
        { error: "invalid token", status: 30001, requestId: "req-auth-400" },
        400,
      );
    });

    await assert.rejects(c.request("GET", "/healthz"), (err) => {
      assert.ok(err instanceof EvermeError);
      assert.equal(err.type, "auth");
      assert.equal(err.classification, "auth");
      assert.equal(err.causeCode, "EVERME_30001");
      assert.equal(err.requestId, "req-auth-400");
      assert.equal(err.attempts, 1);
      return true;
    });
    assert.equal(calls, 1);
  });
});
