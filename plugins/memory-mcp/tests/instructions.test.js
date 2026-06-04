/**
 * Verifies the MCP `initialize.instructions` field is set and references
 * the three EverMe tools. Auto-skips when the SDK is not installed, same
 * pattern as mcp.test.js.
 *
 * Two layers of assertion:
 *   1. The exported EVERME_MCP_INSTRUCTIONS constant carries the
 *      protocol text and mentions mem_context / mem_save_turn / mem_search.
 *   2. A full Client ↔ Server round-trip over InMemoryTransport, so we
 *      catch regressions where the constant is right but the server
 *      forgets to pass it into ServerOptions.
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

describe("mcp instructions", { skip: !sdkAvailable && "SDK not installed" }, () => {
  test("EVERME_MCP_INSTRUCTIONS references all four tools", async () => {
    const { EVERME_MCP_INSTRUCTIONS } = await import("../src/mcp.js");
    assert.ok(EVERME_MCP_INSTRUCTIONS, "instructions string must be non-empty");
    assert.ok(EVERME_MCP_INSTRUCTIONS.includes("mem_context"), "must reference mem_context");
    assert.ok(EVERME_MCP_INSTRUCTIONS.includes("mem_save_turn"), "must reference mem_save_turn");
    assert.ok(EVERME_MCP_INSTRUCTIONS.includes("mem_save_fact"), "must reference mem_save_fact");
    assert.ok(EVERME_MCP_INSTRUCTIONS.includes("mem_search"), "must reference mem_search");
  });

  test("client receives instructions over initialize", async () => {
    process.env.EVERME_API_BASE = "http://127.0.0.1:0";
    process.env.EVERME_AGENT_ID = "agt_x";
    process.env.EVERME_AGENT_TOKEN = "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createMcpServer, EVERME_MCP_INSTRUCTIONS } = await import("../src/mcp.js");

    const { server, dispose } = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const instructions = client.getInstructions();
      assert.equal(instructions, EVERME_MCP_INSTRUCTIONS, "server must advertise the exported instructions verbatim");
    } finally {
      await client.close();
      await server.close();
      await dispose();
    }
  });
});
