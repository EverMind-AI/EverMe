#!/usr/bin/env node
/**
 * Launcher for the everme-memory MCP server under Kimi Code.
 *
 * Kimi Code's plugin manifest is static and shared across all users, and its
 * mcpServers.env cannot carry per-user secrets (no ${VAR} expansion). But
 * @everme/memory-mcp reads its credentials from the environment
 * (EVERME_AGENT_ID / EVERME_AGENT_TOKEN / EVERME_API_BASE). So the manifest
 * launches THIS wrapper instead of npx directly: we load ~/.kimi-code/everme.env
 * (via the shared config loader, which populates process.env) and then exec the
 * real MCP server with stdio inherited, so the JSON-RPC stream passes straight
 * through to the Kimi Code MCP client.
 *
 * If credentials are absent we still spawn the server — it will surface its own
 * "missing EVERME_AGENT_*" boot error, which is the correct, visible signal.
 */
import { spawn } from "node:child_process";
import { getConfig } from "./lib/config.js";

// Side effect: loadEnvFile() inside getConfig() reads $KIMI_CODE_HOME/everme.env
// and sets process.env.EVERME_AGENT_TOKEN / EVERME_AGENT_ID (rotated keys) +
// EVERME_API_BASE when absent.
try {
  getConfig();
} catch {
  /* fall through — let the server report missing credentials itself */
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(npx, ["-y", "@everme/memory-mcp"], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on("error", () => process.exit(1));
