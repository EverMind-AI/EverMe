import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const evtToken = (char = "a") => `evt_${char.repeat(32)}`;
const emkToken = (char = "a") => `emk_${char.repeat(32)}`;
const installedHttpBin = fileURLToPath(
  new URL("../../node_modules/.bin/everme-memory-mcp-http", import.meta.url),
);

async function startServer(options = {}) {
  const { createMcpHttpServer } = await import("../src/http-server.js");
  const server = createMcpHttpServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function stopServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function getUnusedLoopbackPort() {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await stopServer(server);
  return port;
}

async function waitForChildOutput(child, stream, output, pattern, timeoutMs = 5_000) {
  if (pattern.test(output())) return;

  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const succeed = () => {
      cleanup();
      resolve();
    };
    const fail = (err) => {
      cleanup();
      reject(err);
    };
    const onData = () => {
      if (pattern.test(output())) succeed();
    };
    const onError = (err) => {
      fail(err);
    };
    const onExit = (code, signal) => {
      fail(
        new Error(
          `installed npm bin exited before ${pattern}: code=${code}, signal=${signal}, output=${JSON.stringify(output())}`,
        ),
      );
    };
    const timer = setTimeout(() => {
      fail(new Error(`timed out waiting for ${pattern}: output=${JSON.stringify(output())}`));
    }, timeoutMs);

    stream.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function withTimeout(promise, message, timeoutMs = 1_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function startGateway({ holdSearchesUntil = 0 } = {}) {
  const authorizations = [];
  const validationAuthorizations = [];
  let inFlightSearches = 0;
  let maxInFlightSearches = 0;
  let releaseSearches = () => {};
  let releaseTimer;
  const searchGate = holdSearchesUntil > 0
    ? new Promise((resolve) => {
        releaseSearches = () => {
          clearTimeout(releaseTimer);
          resolve();
        };
        releaseTimer = setTimeout(resolve, 3_000);
        releaseTimer.unref?.();
      })
    : Promise.resolve();
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
      // Drain the complete request before replying.
    }
    if (req.method === "POST" && req.url === "/api/v1/mem/capabilities") {
      validationAuthorizations.push(req.headers.authorization || "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: 0,
          requestId: "req-http-validation",
          error: "",
          result: { backend: "v2", capabilities: [] },
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/api/v1/mem/search") {
      authorizations.push(req.headers.authorization || "");
      inFlightSearches += 1;
      maxInFlightSearches = Math.max(maxInFlightSearches, inFlightSearches);
      if (authorizations.length >= holdSearchesUntil) releaseSearches();
      await searchGate;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: 0,
          requestId: "req-http-test",
          error: "",
          result: {
            items: [],
            profiles: [],
            rawMessages: [],
            agentMemory: { cases: [], skills: [] },
          },
        }),
      );
      inFlightSearches -= 1;
      return;
    }
    if (req.method === "POST" && req.url === "/api/v1/mem/agent-memory") {
      authorizations.push(req.headers.authorization || "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: 0,
          requestId: "req-http-agent-memory",
          error: "",
          result: {
            sessionId: "agent:agt_test:conv-1",
            status: "accumulated",
            messageCount: 1,
            flushed: true,
            personalStatus: "extracted",
            personalExtracted: true,
          },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    server,
    authorizations,
    validationAuthorizations,
    maxInFlightSearches: () => maxInFlightSearches,
    releaseSearches,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function request(
  baseUrl,
  path,
  { method = "POST", token, body = {}, rawBody, extraHeaders = {} } = {},
) {
  const headers = { ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined || rawBody !== undefined) {
    headers["Content-Type"] = "application/json";
    headers.Accept = "application/json, text/event-stream";
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body:
      method === "GET" || (body === undefined && rawBody === undefined)
        ? undefined
        : rawBody ?? JSON.stringify(body),
  });
  return { response, text: await response.text() };
}

describe("hosted MCP HTTP executable", () => {
  test("installed npm bin listens and shuts down cleanly", async () => {
    const port = await getUnusedLoopbackPort();
    const child = spawn(installedHttpBin, [], {
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const childExit = once(child, "exit");
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    try {
      await waitForChildOutput(
        child,
        child.stderr,
        () => stderr,
        new RegExp(`listening on 127\\.0\\.0\\.1:${port}`),
      );

      const response = await fetch(`http://127.0.0.1:${port}/missing`);
      assert.equal(response.status, 404);
      await response.text();

      child.kill("SIGTERM");
      const [code, signal] = await childExit;
      assert.equal(code, 0);
      assert.equal(signal, null);
      assert.match(stderr, /received SIGTERM, closing/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await childExit;
      }
    }
  });
});

describe("hosted MCP HTTP routing and authentication", () => {
  test("exposes an unauthenticated health endpoint", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const response = await fetch(`${baseUrl}/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: "ok" });
    } finally {
      await stopServer(server);
    }
  });

  test("supports only POST /mcp", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const wrongMethod = await request(baseUrl, "/mcp", { method: "GET", body: undefined });
      assert.equal(wrongMethod.response.status, 405);
      assert.equal(wrongMethod.response.headers.get("allow"), "POST");

      const wrongPath = await request(baseUrl, "/missing");
      assert.equal(wrongPath.response.status, 404);
    } finally {
      await stopServer(server);
    }
  });

  test("rejects missing, malformed, and EMK bearer credentials without echoing them", async () => {
    const { server, baseUrl } = await startServer();
    const rejected = [undefined, "evt_short", emkToken()];
    try {
      for (const token of rejected) {
        const result = await request(baseUrl, "/mcp", { token });
        assert.equal(result.response.status, 401);
        assert.equal(result.response.headers.get("www-authenticate"), "Bearer");
        if (token) assert.equal(result.text.includes(token), false);
      }
    } finally {
      await stopServer(server);
    }
  });

  test("accepts the strict EVT bearer shape before protocol validation", async () => {
    const { server, baseUrl } = await startServer({ tokenValidator: async () => {} });
    try {
      const result = await request(baseUrl, "/mcp", {
        token: evtToken(),
        body: { not: "json-rpc" },
      });
      assert.notEqual(result.response.status, 401);
      assert.equal(result.text.includes(evtToken()), false);
    } finally {
      await stopServer(server);
    }
  });
});

describe("hosted MCP HTTP resource guards", () => {
  test("rejects malformed JSON and bodies over the configured limit", async () => {
    const { server, baseUrl } = await startServer({
      maxBodyBytes: 32,
      tokenValidator: async () => {},
    });
    try {
      const malformed = await request(baseUrl, "/mcp", {
        token: evtToken(),
        body: undefined,
        rawBody: "{",
      });
      assert.equal(malformed.response.status, 400);
      assert.match(malformed.text, /-32700/);

      const oversized = await request(baseUrl, "/mcp", {
        token: evtToken(),
        body: undefined,
        rawBody: JSON.stringify({ value: "x".repeat(64) }),
      });
      assert.equal(oversized.response.status, 413);
      assert.equal(oversized.text.includes(evtToken()), false);
    } finally {
      await stopServer(server);
    }
  });

  test("rate limits per token digest and resets after the fixed window", async () => {
    let now = 1_000;
    const { server, baseUrl } = await startServer({
      rateLimit: 2,
      rateWindowMs: 1_000,
      tokenValidator: async () => {},
      now: () => now,
    });
    try {
      for (let i = 0; i < 2; i += 1) {
        const allowed = await request(baseUrl, "/mcp", { token: evtToken("a") });
        assert.notEqual(allowed.response.status, 429);
      }

      const blocked = await request(baseUrl, "/mcp", { token: evtToken("a") });
      assert.equal(blocked.response.status, 429);
      assert.equal(blocked.response.headers.get("retry-after"), "1");
      assert.equal(blocked.text.includes(evtToken("a")), false);

      const otherTenant = await request(baseUrl, "/mcp", { token: evtToken("b") });
      assert.notEqual(otherTenant.response.status, 429);

      now = 2_001;
      const reset = await request(baseUrl, "/mcp", { token: evtToken("a") });
      assert.notEqual(reset.response.status, 429);
    } finally {
      await stopServer(server);
    }
  });

  test("bounds tracked token digests and releases capacity in the next time bucket", async () => {
    let now = 1_000;
    const { server, baseUrl } = await startServer({
      rateLimit: 3,
      rateWindowMs: 1_000,
      rateLimitMaxKeys: 2,
      tokenValidator: async () => {},
      now: () => now,
    });
    try {
      for (const token of [evtToken("a"), evtToken("b")]) {
        const tracked = await request(baseUrl, "/mcp", { token });
        assert.notEqual(tracked.response.status, 429);
      }

      const capacityBlocked = await request(baseUrl, "/mcp", { token: evtToken("c") });
      assert.equal(capacityBlocked.response.status, 429);

      const alreadyTracked = await request(baseUrl, "/mcp", { token: evtToken("a") });
      assert.notEqual(alreadyTracked.response.status, 429);

      now = 2_001;
      const nextBucket = await request(baseUrl, "/mcp", { token: evtToken("c") });
      assert.notEqual(nextBucket.response.status, 429);
    } finally {
      await stopServer(server);
    }
  });

  test("does not let unverified token digests consume limiter capacity", async () => {
    const rejectedTokens = [evtToken("a"), evtToken("b"), evtToken("c")];
    const validToken = evtToken("d");
    const validationCalls = [];
    const validationLogs = [];
    const { server, baseUrl } = await startServer({
      rateLimit: 3,
      rateLimitMaxKeys: 1,
      logger: { info() {}, warn: (...args) => validationLogs.push(args.join(" ")) },
      tokenValidator: async (token) => {
        validationCalls.push(token);
        if (rejectedTokens.includes(token)) {
          throw Object.assign(new Error(`invalid token ${token}`), { httpStatus: 401 });
        }
      },
    });
    try {
      for (const token of rejectedTokens) {
        const rejected = await request(baseUrl, "/mcp", { token });
        assert.equal(rejected.response.status, 401);
        assert.equal(rejected.text.includes(token), false);
      }

      const accepted = await request(baseUrl, "/mcp", { token: validToken });
      assert.notEqual(accepted.response.status, 401);
      assert.notEqual(accepted.response.status, 429);
      assert.deepEqual(validationCalls, [...rejectedTokens, validToken]);
      assert.ok(
        rejectedTokens.every((token) => !validationLogs.join("\n").includes(token)),
      );
    } finally {
      await stopServer(server);
    }
  });

  test("caches successful token validation only for the active time bucket", async () => {
    let now = 1_000;
    let validationCalls = 0;
    const token = evtToken("e");
    const { server, baseUrl } = await startServer({
      rateLimit: 10,
      rateWindowMs: 1_000,
      tokenValidator: async () => {
        validationCalls += 1;
      },
      now: () => now,
    });
    try {
      for (let i = 0; i < 2; i += 1) {
        const accepted = await request(baseUrl, "/mcp", { token });
        assert.notEqual(accepted.response.status, 401);
      }
      assert.equal(validationCalls, 1);

      now = 2_001;
      const revalidated = await request(baseUrl, "/mcp", { token });
      assert.notEqual(revalidated.response.status, 401);
      assert.equal(validationCalls, 2);
    } finally {
      await stopServer(server);
    }
  });

  test("bounds concurrent token validations and coalesces duplicate tokens", async () => {
    const tokens = [evtToken("f"), evtToken("g"), evtToken("h")];
    const validationCalls = [];
    let releaseValidations = () => {};
    const validationGate = new Promise((resolve) => {
      releaseValidations = resolve;
    });
    let reportTwoStarted = () => {};
    const twoStarted = new Promise((resolve) => {
      reportTwoStarted = resolve;
    });
    const { server, baseUrl } = await startServer({
      rateLimit: 10,
      tokenValidationMaxPending: 2,
      tokenValidator: async (token) => {
        validationCalls.push(token);
        if (validationCalls.length === 2) reportTwoStarted();
        await validationGate;
      },
    });
    const admittedRequests = [
      request(baseUrl, "/mcp", { token: tokens[0] }),
      request(baseUrl, "/mcp", { token: tokens[0] }),
      request(baseUrl, "/mcp", { token: tokens[1] }),
    ];
    let overflowRequest;
    try {
      await withTimeout(twoStarted, "two token validations did not start");
      overflowRequest = request(baseUrl, "/mcp", { token: tokens[2] });
      const overflow = await withTimeout(
        overflowRequest,
        "validation overflow request did not fail fast",
      );

      assert.equal(overflow.response.status, 429);
      assert.deepEqual([...validationCalls].sort(), tokens.slice(0, 2).sort());

      releaseValidations();
      const admitted = await Promise.all(admittedRequests);
      assert.ok(admitted.every(({ response }) => response.status !== 429));
      assert.equal(validationCalls.filter((token) => token === tokens[0]).length, 1);
    } finally {
      releaseValidations();
      await Promise.allSettled([
        ...admittedRequests,
        ...(overflowRequest ? [overflowRequest] : []),
      ]);
      await stopServer(server);
    }
  });
});

describe("hosted MCP Streamable HTTP transport", () => {
  test("serves all tools statelessly and keeps tenant credentials request-scoped", async () => {
    const gateway = await startGateway();
    const hosted = await startServer({
      apiBase: gateway.baseUrl,
      logger: { info() {}, warn() {} },
    });
    const tokens = [evtToken("a"), evtToken("b")];
    const seenSessionIds = [];

    try {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      );

      for (const token of tokens) {
        const client = new Client(
          { name: "everme-http-test", version: "0.0.0" },
          { capabilities: {} },
        );
        const transport = new StreamableHTTPClientTransport(new URL(`${hosted.baseUrl}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
          fetch: async (input, init) => {
            const response = await fetch(input, init);
            seenSessionIds.push(response.headers.get("mcp-session-id"));
            return response;
          },
        });

        try {
          await client.connect(transport);
          const { tools } = await client.listTools();
          assert.deepEqual(
            tools.map((tool) => tool.name).sort(),
            ["mem_context", "mem_save_fact", "mem_save_turn", "mem_search"],
          );

          const result = await client.callTool({
            name: "mem_search",
            arguments: { query: "tenant isolation" },
          });
          assert.equal(result.isError, undefined);
          assert.match(result.content[0].text, /no matching memories/);
        } finally {
          await client.close();
        }
      }

      assert.deepEqual(
        gateway.authorizations,
        tokens.map((token) => `Bearer ${token}`),
      );
      assert.deepEqual(
        gateway.validationAuthorizations,
        tokens.map((token) => `Bearer ${token}`),
      );
      assert.ok(seenSessionIds.length >= 2);
      assert.ok(seenSessionIds.every((value) => value === null));
    } finally {
      await stopServer(hosted.server);
      await stopServer(gateway.server);
    }
  });

  test("mem_save_turn surfaces the derived profile verdict", async () => {
    const gateway = await startGateway();
    const hosted = await startServer({
      apiBase: gateway.baseUrl,
      logger: { info() {}, warn() {} },
    });
    const token = evtToken("p");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const client = new Client(
      { name: "everme-http-profile-test", version: "0.0.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${hosted.baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "mem_save_turn",
        arguments: { sessionKey: "conv-1", text: "deploy succeeded" },
      });
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.profileStatus, "extracted");
      assert.equal(payload.profileUpdated, true);
    } finally {
      await client.close().catch(() => {});
      await stopServer(hosted.server);
      await stopServer(gateway.server);
    }
  });

  test("isolates concurrent tenants and cleans every request lifecycle exactly once", async () => {
    const { createMcpServer } = await import("../src/mcp.js");
    const { StreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/streamableHttp.js"
    );
    const lifecycle = {
      serversCreated: 0,
      serversClosed: 0,
      transportsCreated: 0,
      transportsClosed: 0,
      disposersCalled: 0,
    };
    const mcpServerFactory = (options) => {
      lifecycle.serversCreated += 1;
      const built = createMcpServer(options);
      const close = built.server.close.bind(built.server);
      const dispose = built.dispose;
      built.server.close = async () => {
        lifecycle.serversClosed += 1;
        await close();
      };
      built.dispose = async () => {
        lifecycle.disposersCalled += 1;
        await dispose();
      };
      return built;
    };
    const transportFactory = (options) => {
      lifecycle.transportsCreated += 1;
      const transport = new StreamableHTTPServerTransport(options);
      const close = transport.close.bind(transport);
      transport.close = async () => {
        lifecycle.transportsClosed += 1;
        await close();
      };
      return transport;
    };
    const gateway = await startGateway({ holdSearchesUntil: 2 });
    const hosted = await startServer({
      apiBase: gateway.baseUrl,
      logger: { info() {}, warn() {} },
      mcpServerFactory,
      transportFactory,
    });
    const tokens = [evtToken("c"), evtToken("d")];
    const seenSessionIds = [];

    try {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      );

      const results = await Promise.all(
        tokens.map(async (token) => {
          const client = new Client(
            { name: "everme-http-concurrency-test", version: "0.0.0" },
            { capabilities: {} },
          );
          const transport = new StreamableHTTPClientTransport(new URL(`${hosted.baseUrl}/mcp`), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
            fetch: async (input, init) => {
              const response = await fetch(input, init);
              seenSessionIds.push(response.headers.get("mcp-session-id"));
              return response;
            },
          });
          try {
            await client.connect(transport);
            const listed = await client.listTools();
            const searched = await client.callTool({
              name: "mem_search",
              arguments: { query: "concurrent tenant isolation" },
            });
            return { listed, searched };
          } finally {
            await client.close();
          }
        }),
      );

      assert.equal(gateway.maxInFlightSearches(), 2);
      assert.deepEqual(
        [...gateway.authorizations].sort(),
        tokens.map((token) => `Bearer ${token}`).sort(),
      );
      assert.deepEqual(
        [...gateway.validationAuthorizations].sort(),
        tokens.map((token) => `Bearer ${token}`).sort(),
      );
      assert.ok(seenSessionIds.length >= 2);
      assert.ok(seenSessionIds.every((value) => value === null));
      for (const { listed, searched } of results) {
        assert.deepEqual(
          listed.tools.map((tool) => tool.name).sort(),
          ["mem_context", "mem_save_fact", "mem_save_turn", "mem_search"],
        );
        assert.equal(searched.isError, undefined);
      }

      assert.ok(lifecycle.serversCreated > 0);
      assert.equal(lifecycle.serversClosed, lifecycle.serversCreated);
      assert.equal(lifecycle.transportsCreated, lifecycle.serversCreated);
      assert.equal(lifecycle.transportsClosed, lifecycle.serversCreated);
      assert.equal(lifecycle.disposersCalled, lifecycle.serversCreated);
    } finally {
      gateway.releaseSearches();
      await stopServer(hosted.server);
      await stopServer(gateway.server);
    }
  });
});

describe("hosted MCP SSE transport", () => {
  test("server shutdown closes active SSE sessions before waiting for connections", async () => {
    const hosted = await startServer({
      logger: { info() {}, warn() {} },
      tokenValidator: async () => {},
    });
    const controller = new AbortController();
    let closePromise;

    try {
      const response = await fetch(`${hosted.baseUrl}/sse`, {
        headers: { Authorization: `Bearer ${evtToken("q")}` },
        signal: controller.signal,
      });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      const firstEvent = await reader.read();
      assert.match(Buffer.from(firstEvent.value).toString("utf8"), /event: endpoint/);

      closePromise = new Promise((resolve, reject) => {
        hosted.server.close((err) => (err ? reject(err) : resolve()));
      });
      await withTimeout(closePromise, "server shutdown waited on the active SSE session", 250);
      assert.equal(hosted.server.listening, false);
    } finally {
      controller.abort();
      hosted.server.closeAllConnections?.();
      await closePromise?.catch(() => {});
      await stopServer(hosted.server);
    }
  });

  test("serves all tools and keeps bearer credentials on both SSE requests", async () => {
    const gateway = await startGateway();
    const hosted = await startServer({
      apiBase: gateway.baseUrl,
      logger: { info() {}, warn() {} },
    });
    const token = evtToken("s");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
    const client = new Client(
      { name: "everme-sse-test", version: "0.0.0" },
      { capabilities: {} },
    );
    const transport = new SSEClientTransport(new URL(`${hosted.baseUrl}/sse`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        ["mem_context", "mem_save_fact", "mem_save_turn", "mem_search"],
      );
      const result = await client.callTool({
        name: "mem_search",
        arguments: { query: "manus hosted memory" },
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(gateway.authorizations, [`Bearer ${token}`]);
      assert.deepEqual(gateway.validationAuthorizations, [`Bearer ${token}`]);
    } finally {
      await client.close().catch(() => {});
      await stopServer(hosted.server);
      await stopServer(gateway.server);
    }
  });

  test("rejects missing auth, unknown sessions, and token-mismatched messages", async () => {
    const hosted = await startServer({
      logger: { info() {}, warn() {} },
      tokenValidator: async () => {},
    });
    const openingToken = evtToken("a");
    const messageToken = evtToken("b");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
    const client = new Client(
      { name: "everme-sse-token-test", version: "0.0.0" },
      { capabilities: {} },
    );
    const transport = new SSEClientTransport(new URL(`${hosted.baseUrl}/sse`), {
      requestInit: { headers: { Authorization: `Bearer ${messageToken}` } },
      eventSourceInit: {
        fetch: (input, init = {}) => fetch(input, {
          ...init,
          headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: `Bearer ${openingToken}` },
        }),
      },
    });

    try {
      const missing = await request(hosted.baseUrl, "/sse", {
        method: "GET",
        body: undefined,
      });
      assert.equal(missing.response.status, 401);

      const unknown = await request(hosted.baseUrl, "/messages?sessionId=missing", {
        token: openingToken,
      });
      assert.equal(unknown.response.status, 404);

      await assert.rejects(client.connect(transport), /401|Unauthorized|POSTing to endpoint/);
    } finally {
      await client.close().catch(() => {});
      await stopServer(hosted.server);
    }
  });
});
