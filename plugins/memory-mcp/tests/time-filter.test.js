/**
 * mem_search time bounds — the tool-surface half of the contract.
 *
 * agent-sdk owns compiling startTime / endTime into filters.timestamp (see
 * agent-sdk/tests/search.test.js); what is checked here is what the MCP tool
 * does around it: the compiled window actually reaches the gateway, the
 * response echoes the window that was applied, and a bad bound comes back as
 * a tool error carrying a usable example instead of killing the call.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
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

function startGateway(bodies) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        bodies.push(JSON.parse(raw || "{}"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: 0, result: { items: [] } }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function withTool(bodies, run) {
  const gateway = await startGateway(bodies);
  const { port } = gateway.address();
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createMcpServer } = await import("../src/mcp.js");

  const { server, dispose } = createMcpServer({
    config: {
      apiBase: `http://127.0.0.1:${port}`,
      agentId: "agt_x",
      agentToken: "evt_" + "a".repeat(32),
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "time-filter-test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
    await dispose();
    gateway.close();
  }
}

describe("mem_search time bounds", { skip: !sdkAvailable && "SDK not installed" }, () => {
  test("compiled bounds reach the gateway as filters.timestamp and are echoed back", async () => {
    const bodies = [];
    const res = await withTool(bodies, (client) =>
      client.callTool({
        name: "mem_search",
        arguments: {
          query: "bug fixes",
          startTime: "2026-09-09T00:00:00+08:00",
          endTime: "2026-09-09T23:59:59+08:00",
        },
      }),
    );

    assert.equal(bodies.length, 1);
    assert.deepEqual(bodies[0].filters, {
      timestamp: { gte: "2026-09-09T00:00:00+08:00", lte: "2026-09-09T23:59:59+08:00" },
    });
    assert.match(
      res.content[0].text,
      /_Time filter applied: 2026-09-09T00:00:00\+08:00 → 2026-09-09T23:59:59\+08:00_/,
    );
  });

  test("a query with no bounds sends no filters and echoes no window", async () => {
    const bodies = [];
    const res = await withTool(bodies, (client) =>
      client.callTool({ name: "mem_search", arguments: { query: "unit test framework" } }),
    );

    assert.ok(!("filters" in bodies[0]), "an unfiltered search must not send an empty filters object");
    assert.ok(!res.content[0].text.includes("Time filter applied"));
  });

  test("a reversed window is a tool error with a usable example, not a crash", async () => {
    const bodies = [];
    const res = await withTool(bodies, (client) =>
      client.callTool({
        name: "mem_search",
        arguments: {
          query: "durian",
          startTime: "2026-09-10T00:00:00+08:00",
          endTime: "2026-09-09T00:00:00+08:00",
        },
      }),
    );

    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /startTime must not be after endTime/);
    assert.match(res.content[0].text, /2026-09-09T00:00:00\+08:00/);
    assert.equal(bodies.length, 0, "a rejected bound must never reach the gateway");
  });

  test("an unparseable bound is rejected rather than silently dropped", async () => {
    const bodies = [];
    const res = await withTool(bodies, (client) =>
      client.callTool({ name: "mem_search", arguments: { query: "durian", startTime: "yesterday" } }),
    );

    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /invalid timestamp: yesterday/);
    assert.equal(bodies.length, 0);
  });
});
