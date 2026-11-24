/**
 * The fixed text this server writes names the brand of its credentials.
 * Memory content is the user's and stays as it was stored, even where it
 * names EverMe.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let sdkAvailable = true;
try {
  require.resolve("@modelcontextprotocol/sdk/client/index.js");
  require.resolve("@modelcontextprotocol/sdk/inMemory.js");
} catch {
  sdkAvailable = false;
}

afterEach(() => {
  delete process.env.EVERME_BRAND;
});

async function withClient(fn) {
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
    await fn(client);
  } finally {
    await client.close();
    await server.close();
    await dispose();
  }
}

describe("EverOS brand in fixed MCP text", { skip: !sdkAvailable && "SDK not installed" }, () => {
  test("search results header names EverOS and keeps memory content", async () => {
    process.env.EVERME_BRAND = "everos";
    const { renderSearchResultsAsMarkdown } = await import("../src/mcp.js");
    const md = renderSearchResultsAsMarkdown("editor", {
      memories: [{ type: "episodic_memory", episode: "User installed EverMe on Zed" }],
    });
    assert.match(md, /^## EverOS search results for "editor"/);
    assert.match(md, /User installed EverMe on Zed/);
  });

  test("search results header is unchanged for EverMe", async () => {
    const { renderSearchResultsAsMarkdown } = await import("../src/mcp.js");
    const md = renderSearchResultsAsMarkdown("editor", { memories: [] });
    assert.match(md, /^## EverMe search results for "editor"/);
  });

  test("resources and templates name EverOS", async () => {
    process.env.EVERME_BRAND = "everos";
    await withClient(async (client) => {
      const { resources } = await client.listResources();
      const { resourceTemplates } = await client.listResourceTemplates();
      const listed = JSON.stringify({ resources, resourceTemplates });
      assert.doesNotMatch(listed, /EverMe/);
      assert.match(listed, /EverOS/);
    });
  });

  test("an unknown resource URI error names EverOS", async () => {
    process.env.EVERME_BRAND = "everos";
    await withClient(async (client) => {
      await assert.rejects(
        client.readResource({ uri: "mem://nope" }),
        (err) => /EverOS/.test(err.message) && !/EverMe/.test(err.message),
      );
    });
  });
});
