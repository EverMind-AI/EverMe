/**
 * mem_skill: the read side of progressive skill loading.
 *
 * A recall block prints a skill's id and one-line summary; the body sits in
 * the shared local state dir, written by whichever process ran the search.
 * These tests pin that the tool is advertised, that a cached id comes back
 * whole, and — the one that matters most — that an id with no cached body is
 * reported as a miss instead of being papered over (plugins/AGENTS.md 0, no
 * fake degradation).
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

const SKILL = {
  id: "6a98d9504ff33830c399cf66",
  name: "Security and compliance review",
  description: "How to scope and run a review before a release",
  content: "## Steps\n1. Scope the review\n2. Check the diff",
  relevanceScore: 0.99,
};

async function connect() {
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
  return {
    client,
    async close() {
      await client.close();
      await server.close();
      await dispose();
    },
  };
}

describe("mem_skill tool", { skip: !sdkAvailable && "SDK not installed" }, () => {
  let dir;
  let previous;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "everme-mcp-skill-"));
    previous = process.env.EVERME_STATE_DIR;
    process.env.EVERME_STATE_DIR = dir;
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env.EVERME_STATE_DIR;
    else process.env.EVERME_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });

  test("tools/list advertises mem_skill with a required id", async () => {
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === "mem_skill");
      assert.ok(tool, "mem_skill must be listed alongside mem_search / mem_context");
      assert.deepEqual(tool.inputSchema.required, ["id"]);
      assert.ok(tool.description.includes("mem_search"),
        "the description must point at where a valid id comes from");
    } finally {
      await close();
    }
  });

  test("returns the full body for a cached id", async () => {
    const { createSkillContentCache } = await import("@everme/agent-sdk");
    await createSkillContentCache({ stateDir: dir }).write([SKILL]);

    const { client, close } = await connect();
    try {
      const res = await client.callTool({ name: "mem_skill", arguments: { id: SKILL.id } });
      const text = res.content[0].text;
      assert.ok(!res.isError, `expected a hit, got: ${text}`);
      assert.match(text, /Security and compliance review/);
      assert.match(text, /1\. Scope the review/, "the body is what this tool exists to return");
      assert.match(text, new RegExp(SKILL.id));
    } finally {
      await close();
    }
  });

  test("an uncached id is an honest miss, never substitute content", async () => {
    const { client, close } = await connect();
    try {
      const res = await client.callTool({ name: "mem_skill", arguments: { id: "ffffffffffffffffffffffff" } });
      assert.equal(res.isError, true, "a miss must be an error, not a successful empty answer");
      const text = res.content[0].text;
      assert.match(text, /not in this machine's local skill cache/);
      assert.match(text, /mem_search/, "the message must say how to recover");
    } finally {
      await close();
    }
  });

  test("a missing id argument is rejected with the shape of a valid one", async () => {
    const { client, close } = await connect();
    try {
      const res = await client.callTool({ name: "mem_skill", arguments: {} });
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /\[skill <id>\]/);
    } finally {
      await close();
    }
  });

  test("resources/templates/list advertises mem://skill for hosts that bridge resources only", async () => {
    const { client, close } = await connect();
    try {
      const { resourceTemplates } = await client.listResourceTemplates();
      const tpl = resourceTemplates.find((r) => r.uriTemplate === "mem://skill?id={id}");
      assert.ok(tpl, "Codex bridges MCP through resources/read, so the tool needs a URI twin");
      assert.equal(tpl.mimeType, "text/markdown");
    } finally {
      await close();
    }
  });

  test("mem://skill reads a cached body and fails loudly on a miss", async () => {
    const { createSkillContentCache } = await import("@everme/agent-sdk");
    await createSkillContentCache({ stateDir: dir }).write([SKILL]);

    const { client, close } = await connect();
    try {
      const hit = await client.readResource({ uri: `mem://skill?id=${SKILL.id}` });
      assert.match(hit.contents[0].text, /1\. Scope the review/);
      await assert.rejects(
        () => client.readResource({ uri: "mem://skill?id=ffffffffffffffffffffffff" }),
        /not in this machine's local skill cache/,
      );
    } finally {
      await close();
    }
  });
});
