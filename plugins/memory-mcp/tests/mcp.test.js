/**
 * MCP smoke test — only runs when @modelcontextprotocol/sdk is present
 * (npm install has been run). Otherwise auto-skips so a fresh checkout
 * still passes `npm test` without dragging in node_modules.
 *
 * To run the full suite once deps are installed:
 *   npm install && npm run test:all
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let sdkAvailable = true;
try {
  require.resolve("@modelcontextprotocol/sdk/server/index.js");
} catch {
  sdkAvailable = false;
}

describe("mcp", { skip: !sdkAvailable && "SDK not installed" }, () => {
  test("createMcpServer wires tools and config", async () => {
    process.env.EVERME_API_BASE = "http://127.0.0.1:0";
    process.env.EVERME_AGENT_ID = "agt_x";
    process.env.EVERME_AGENT_TOKEN = "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const { createMcpServer } = await import("../src/mcp.js");
    const { server, cfg, dispose } = createMcpServer();
    assert.ok(server, "server constructed");
    assert.equal(cfg.agentId, "agt_x");
    assert.equal(cfg.baseUrl, "http://127.0.0.1:0/api/v1");
    assert.equal(typeof dispose, "function",
      "createMcpServer must expose dispose() so the bin entry point can clean up on SIGINT/SIGTERM");
    // dispose currently has no buffered runtime writes, but must resolve cleanly.
    await dispose();
  });
});
