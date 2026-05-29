/**
 * Tool schema stability guard.
 *
 * The three EverMe tool names, the `required` shape of their input
 * schemas, and the response shape returned by the dispatch layer are
 * load-bearing for every MCP host integration we ship. A silent rename
 * (e.g. `mem_context` -> `memory_context`) or dropping `query` from
 * `required` would cascade into broken host installs without any
 * runtime error — host LLMs would just stop calling the tools.
 *
 * This test pins the surface so the change is loud.
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

describe("mcp tool schema", { skip: !sdkAvailable && "SDK not installed" }, () => {
  test("tools/list exposes mem_search / mem_context / mem_save_turn / mem_save_fact with stable required fields", async () => {
    process.env.EVERME_API_BASE = "http://127.0.0.1:0";
    process.env.EVERME_AGENT_ID = "agt_x";
    process.env.EVERME_AGENT_TOKEN = "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createMcpServer } = await import("../src/mcp.js");

    const { server, dispose } = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const { tools } = await client.listTools();
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

      assert.ok(byName.mem_search, "mem_search must be advertised");
      assert.ok(byName.mem_context, "mem_context must be advertised");
      assert.ok(byName.mem_save_turn, "mem_save_turn must be advertised");
      assert.ok(byName.mem_save_fact, "mem_save_fact must be advertised — the profile-write sibling of mem_save_turn");
      assert.equal(tools.length, 4, "no unexpected tools advertised — surface is search/context/save_turn/save_fact");

      assert.deepEqual(
        byName.mem_search.inputSchema.required,
        ["query"],
        "mem_search.query stays required — instructions tell hosts to pass it verbatim",
      );
      assert.deepEqual(
        byName.mem_context.inputSchema.required,
        ["query"],
        "mem_context.query stays required — A.2 instructions depend on a concrete query value",
      );
      assert.equal(
        byName.mem_save_turn.inputSchema.required,
        undefined,
        "mem_save_turn has no top-level required: either single-message or trajectory form is acceptable",
      );
      assert.equal(
        byName.mem_save_fact.inputSchema.required,
        undefined,
        "mem_save_fact has no top-level required: either `fact` or `messages` form is acceptable",
      );
      assert.deepEqual(
        byName.mem_save_fact.inputSchema.properties.messages.items.properties.role.enum,
        ["user", "assistant"],
        "mem_save_fact rejects tool roles — the personal-memory path is user/assistant only",
      );

      // mem_context handler calls getContext(client, args.query, {}, log)
      // and never threads topK into the gateway. Advertising topK in the
      // schema while ignoring it at the handler is a discoverability
      // trap — hosts/LLMs that template `topK` for both tools see
      // identical contracts but different behavior. Keep the schema and
      // the handler in sync.
      assert.equal(
        byName.mem_context.inputSchema.properties.topK,
        undefined,
        "mem_context must not advertise topK — the handler ignores it; mem://search?topK= is the way to scale Resources output",
      );
    } finally {
      await client.close();
      await server.close();
      await dispose();
    }
  });
});
