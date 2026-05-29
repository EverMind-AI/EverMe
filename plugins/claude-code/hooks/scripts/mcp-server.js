#!/usr/bin/env node
/**
 * MCP server bundled with the Claude Code plugin. Exposes the
 * EverMe gateway's search + context endpoints as MCP tools so users
 * can ALSO recall memory manually via natural language ("search my
 * memory for the Postgres index thing"), even when the
 * UserPromptSubmit hook has already done implicit recall.
 *
 * Wire format: MCP stdio transport (JSON-RPC 2.0 framed by line).
 * We hand-roll the tiny subset Claude Code uses rather than pulling
 * in @modelcontextprotocol/sdk — keeps the install fast (no npm
 * install required) and the dependency surface minimal.
 *
 * Tools:
 *   everme_search   — POST /api/v1/mem/search
 *   everme_context  — POST /api/v1/mem/context (server-rendered prompt block)
 */

import { createInterface } from "readline";
import { createRequire } from "node:module";
import { buildMemoryPrompt } from "@everme/agent-sdk";
import { searchMemories, getContext, EvermeError } from "./lib/api.js";
import { isConfigured } from "./lib/config.js";
import { renderProfileBlock } from "./lib/profile.js";
import { redactError, debug } from "./lib/redact.js";

// Derive serverInfo.version from package.json so the value tracks the
// plugin release rather than rotting as a hard-coded literal. We sit at
// hooks/scripts/mcp-server.js → ../ is hooks/, ../../ is the plugin
// root where package.json lives. (`../../../` would land in
// node_modules/@everme/, which has no package.json and blows up the
// server at startup — that was the 0.3.1 bug Claude Code surfaced as
// "Failed to connect" for plugin:everme:everme.)
const { version: PKG_VERSION } = createRequire(import.meta.url)("../../package.json");

// Protocol versions this hand-rolled server knows about. Clients that
// announce one of these in `initialize` get their version echoed back
// (per MCP spec the server SHOULD agree to the client's version when
// supported); anything else falls back to the newest we support so the
// session can still establish. Prior code hard-coded "2024-11-05" while
// Claude Code already negotiates "2025-03-26".
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26"]);
const LATEST_PROTOCOL_VERSION = "2025-03-26";

const TOOLS = [
  {
    name: "everme_search",
    description:
      "Search EverMe memories from past sessions. Returns ranked memory items with subject, summary, and relevance score. Use when the user asks about previous work, decisions, or context. Params: query (required), topK (default 10, max 25).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query — keywords or a question" },
        topK: { type: "number", description: "Max results (default 10, max 25)" },
      },
      required: ["query"],
    },
  },
  {
    name: "everme_context",
    description:
      "Fetch the server-rendered context block (profile + recent episodes) the gateway uses for prompt injection. Useful when you want a single ready-to-paste summary. Params: query (optional), topK (default 5).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional query for relevance-biased context" },
        topK: { type: "number", description: "Max items to include (default 5)" },
      },
    },
  },
];

const handlers = {
  initialize: (params) => {
    const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested)
      ? requested
      : LATEST_PROTOCOL_VERSION;
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "everme", version: PKG_VERSION },
    };
  },
  "tools/list": () => ({ tools: TOOLS }),
  "tools/call": async (params) => {
    const name = params?.name;
    const args = params?.arguments || {};
    if (!isConfigured()) {
      return errResp("EverMe not configured: set EVERME_API_KEY (emk) or EVERME_AGENT_TOKEN");
    }
    try {
      switch (name) {
        case "everme_search": {
          // Render the SDK bundle through buildMemoryPrompt — same
          // path inject-memories.js uses for the auto-recall hook,
          // and the same shape @everme/memory-mcp's mem_search tool
          // returns. Earlier `JSON.stringify(res, null, 2)` forced the
          // host LLM to peel a JSON envelope and decode escaped
          // newlines before any of the section bullets were readable.
          const topK = Math.min(Number(args.topK) || 10, 25);
          const res = await searchMemories(String(args.query || ""), { topK });
          const body = buildMemoryPrompt(res, { wrapInCodeBlock: false });
          const header = `## EverMe search results for "${String(args.query || "")}"`;
          const trimmed = body.replace(/^## Relevant memory\n\n?/, "");
          const text = trimmed
            ? `${header}\n\n${trimmed}`
            : `${header}\n\n_(no matching memories)_`;
          return ok(redactError(text));
        }
        case "everme_context": {
          // getContext returns the gateway's raw shape
          // {profile, cachedAt, generatedAt} — the markdown lives in
          // res.profile as a structured object, NOT a string. Render
          // via renderProfileBlock (same renderer session-start.js
          // uses for the SessionStart hook injection) so the Tools
          // path matches what users already see in the injected
          // <everme_profile> block.
          const res = await getContext(String(args.query || ""), {});
          // renderProfileBlock returns "" when profile exists but has no
          // facts/traits yet (new account). Check the rendered output, not
          // just the wrapper object, so the empty case yields a fallback
          // message instead of an empty tool result.
          const rendered = res?.profile ? renderProfileBlock(res.profile) : "";
          const text = rendered || "_(no profile available — your EverMe account has no extracted memories yet)_";
          return ok(redactError(text));
        }
        default:
          return errResp(`unknown tool: ${name}`);
      }
    } catch (err) {
      const safe = redactError(err instanceof EvermeError ? err.message : err?.message || String(err));
      debug("mcp", `tool ${name} failed:`, safe);
      return errResp(safe);
    }
  },
};

function ok(text) {
  return { content: [{ type: "text", text: String(text ?? "") }] };
}
function errResp(msg) {
  return { isError: true, content: [{ type: "text", text: `error: ${msg}` }] };
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", async (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return; // ignore malformed lines
  }
  const handler = handlers[req?.method];
  if (!handler) {
    if (req?.id != null) {
      respond(req.id, undefined, { code: -32601, message: `method not found: ${req?.method}` });
    }
    return;
  }
  try {
    const result = await handler(req?.params);
    if (req?.id != null) respond(req.id, result);
  } catch (err) {
    if (req?.id != null) {
      respond(req.id, undefined, {
        code: -32000,
        message: redactError(err?.message || String(err)),
      });
    }
  }
});

function respond(id, result, error) {
  const env = error
    ? { jsonrpc: "2.0", id, error }
    : { jsonrpc: "2.0", id, result };
  process.stdout.write(JSON.stringify(env) + "\n");
}

debug("mcp", "everme MCP server ready");
