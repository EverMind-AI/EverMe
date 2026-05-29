#!/usr/bin/env node
/**
 * Stdio MCP entry point — what `npx -y @everme/memory-mcp` resolves to.
 *
 * Lifecycle:
 *   1. evercli plugin install writes ~/.claude.json with this command
 *      and the EVERME_* env vars.
 *   2. The host (Claude Code, Cursor, …) spawns this script as a child
 *      process, speaks MCP over stdio.
 *   3. createMcpServer() validates env, builds the tool surface.
 *   4. We connect to the StdioServerTransport and yield to the SDK loop.
 *
 * Errors at boot (missing env, network unreachable) are reported on
 * stderr and the process exits 1 — the host surfaces it to the user.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "../src/mcp.js";

// stderr-only logger — stdout is reserved for MCP protocol frames.
const logger = {
  info: (...a) => console.error("[everme-mcp]", ...a),
  warn: (...a) => console.error("[everme-mcp]", ...a),
};

(async () => {
  let server, dispose;
  try {
    ({ server, dispose } = createMcpServer({ logger }));
  } catch (err) {
    console.error(`[everme-mcp] boot failed: ${err?.message || err}`);
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
    logger.info("connected to host via stdio");
  } catch (err) {
    console.error(`[everme-mcp] transport connect failed: ${err?.message || err}`);
    process.exit(1);
  }

  // Graceful shutdown. Runtime writes are synchronous via mem_save_turn, so
  // dispose is currently a no-op hook kept for future cleanup.
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.once(sig, async () => {
      logger.info(`received ${sig}, closing`);
      try {
        await dispose();
      } catch (err) {
        logger.warn(`dispose failed: ${err?.message || err}`);
      }
      await server.close().catch(() => {});
      process.exit(0);
    });
  }
})();
