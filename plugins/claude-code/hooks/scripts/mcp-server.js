#!/usr/bin/env node
/**
 * MCP server bundled with the Claude Code plugin. Exposes the canonical
 * EverMe four-tool catalogue (mem_search / mem_context / mem_save_turn /
 * mem_save_fact — the same public ABI as @everme/memory-mcp and the Go
 * hosted /mcp surface).
 *
 * Wire format: MCP stdio transport (JSON-RPC 2.0 framed by line).
 * We hand-roll the tiny subset Claude Code uses rather than pulling
 * in @modelcontextprotocol/sdk — keeps the install fast (no npm
 * install required) and the dependency surface minimal. The canonical
 * tools are a thin adapter over @everme/agent-sdk helpers — this
 * package must NOT import @everme/memory-mcp (host packages depend on
 * agent-sdk only).
 */

import { createInterface } from "readline";
import { createRequire } from "node:module";
import {
  buildMemoryPrompt,
  createClient,
  getContext,
  searchMemory,
  saveAgentMemory,
  savePersonalMemory,
  AGENT_MEMORY_ROLES,
  redactError,
  describeError,
  EvermeError,
} from "@everme/agent-sdk";
import { getConfig, isConfigured } from "./lib/config.js";

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
let client;

// stdout carries the JSON-RPC stream; HTTP diagnostics (per-request
// requestId lines) go to stderr like every other hook surface.
const stderrLog = {
  info(line) {
    try {
      process.stderr.write(`${line}\n`);
    } catch {
      // A closed stderr must never break the MCP stream.
    }
  },
  warn(line) {
    this.info(line);
  },
};

function getClient() {
  if (!client) client = createClient(getConfig(), stderrLog);
  return client;
}

// Instructions returned on initialize — Claude Code splices them into the
// system prompt. Mirrors @everme/memory-mcp's EVERME_MCP_INSTRUCTIONS with
// the Claude-Code-specific note that native hooks already inject
// <everme_profile> / <everme_recall> and save turns automatically.
const INSTRUCTIONS = [
  "EverMe memory is connected. This plugin's native hooks already inject a",
  "<everme_profile> block at session start and a <everme_recall> block before",
  "each prompt, and they save the conversation automatically — so the tools",
  "below are for the cases the hooks do not cover. Call them AUTONOMOUSLY when",
  "a trigger fires; never wait for the user to say \"remember\" or \"recall\".",
  "1. The <everme_recall> block is missing, empty, or clearly irrelevant AND the user references earlier conversations, decisions, conventions, or previously solved problems — call `mem_search` with a SHORT query. Do not repeat an identical query in the same turn.",
  "2. The user states a durable fact about themselves (a preference, habit, trait, long-term goal, or decision) — call `mem_save_fact` immediately. Only `extracted:true` / `profileUpdated:true` means the profile really updated; on `no_extraction` do NOT tell the user the fact was remembered, and do not auto-retry.",
  "3. A task was solved in a way worth reusing and the trajectory is NOT already captured by the hooks — call `mem_save_turn` with the COMPLETE trajectory. It feeds episodic / case / skill extraction; chat-dual-write backends may also update the Profile, reported by profileUpdated.",
  "4. No <everme_profile> block was injected this session — call `mem_context` once. It returns the durable Profile ONLY (no search, no episodes).",
].join("\n");

const TOOLS = [
  {
    name: "mem_search",
    description:
      "Search EverMe memory for entries relevant to a free-text query. " +
      "Returns the top-K matching entries (episodic, profile, agent " +
      "cases/skills, recent raw transcript) rendered as markdown; rows " +
      "under the provisional transcript header are not yet extracted and " +
      "must not be quoted as established facts.\n\n" +
      "Call this proactively — without being asked — whenever the user " +
      "references prior conversations, earlier decisions, project " +
      "conventions, or previously solved problems (\"what did we say " +
      "about X\", \"remember when…\", \"like last time\", \"did we fix " +
      "this before\", \"continue where we left off\").\n\n" +
      "Skip the call when the host already injected a non-empty, relevant " +
      "<everme_recall> block this turn, and do not repeat an identical " +
      "query within the same turn.\n\n" +
      "`query` is KEYWORDS ONLY — the topic, not the conversation. Two to " +
      "eight words, under ~100 characters, no sentences copied from the " +
      "transcript. Never pass the user's whole message, a file, a log, a " +
      "diff, or your own reasoning: the search embeds whatever you send, " +
      "so boilerplate crowds out the topic and the results get worse. " +
      "Good: \"oauth token rotation\". Bad: the last three turns pasted " +
      "in. Rely on the default topK of 10; only raise it if a first " +
      "search genuinely missed.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Keywords naming the topic to recall — two to eight words, " +
            "under ~100 characters. Not a sentence from the transcript, " +
            "not the user's whole message, not a pasted file or log.",
        },
        topK: { type: "integer", description: "Max entries to return", default: 10 },
      },
      required: ["query"],
    },
  },
  {
    name: "mem_context",
    description:
      "Read the current user's durable Profile snapshot ONLY. This tool " +
      "never performs semantic search and never returns episodic memories, " +
      "raw messages, agent cases, or agent skills.\n\n" +
      "Call it ONCE at the start of a session, and only when no " +
      "<everme_profile> block was injected. Do NOT use it as a fallback for " +
      "recalling past decisions, old sessions, or task context — that is " +
      "mem_search's job.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Deprecated and ignored — mem_context never performs semantic " +
            "search. Kept for backwards compatibility only.",
        },
        forceRefresh: {
          type: "boolean",
          default: false,
          description: "Bypass the server-side profile cache and re-read the upstream profile.",
        },
      },
    },
  },
  {
    name: "mem_save_turn",
    description:
      "Persist a conversation trajectory in realtime via /mem/agent-memory. " +
      "Use sessionKey as conversationId.\n\n" +
      "Call this when a task was solved in a way worth reusing AND the " +
      "trajectory is not already captured by the plugin's automatic " +
      "transcript save. Pass the COMPLETE round-trip — messages: [{role, " +
      "content, timestamp?, toolCalls?, toolCallId?}] — EverOS only " +
      "extracts agent_case / agent_skill from trajectories carrying the " +
      "full tool round-trip.\n\n" +
      "By default flush=true: extraction into episodic / agent_case / " +
      "agent_skill runs right away. Pass flush=false for append-only " +
      "accumulation. The primary trajectory path extracts episodic / case / " +
      "skill memory; chat-dual-write backends may also update the user's " +
      "Profile. Check profileUpdated for the derived profile verdict, and " +
      "use mem_save_fact for deliberate durable user facts.",
    inputSchema: {
      type: "object",
      properties: {
        role: {
          type: "string",
          enum: ["user", "assistant", "tool"],
          description: "Role for the single-message form. Ignored when messages[] is set.",
        },
        text: { type: "string", description: "Content for the single-message form. Ignored when messages[] is set." },
        timestamp: { type: "integer", description: "Unix milliseconds; defaults to now. Single-message form only." },
        toolCallId: { type: "string", description: "Required when role=tool. Single-message form only." },
        toolCalls: {
          type: "array",
          description:
            "Tool invocations made by an assistant message. Required when " +
            "the assistant called tools — without this the tool round-trip " +
            "can never be reconstructed downstream and EverOS will not " +
            "produce agent_case / agent_skill from the turn.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              arguments: { type: "string", description: "JSON-encoded tool arguments (stringified, not an object)." },
            },
            required: ["id", "name", "arguments"],
          },
        },
        messages: {
          type: "array",
          description:
            "Multi-message trajectory. Preferred for recording a complete " +
            "user → assistant{tool_use} → tool{tool_result} → assistant cycle.",
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: ["user", "assistant", "tool"] },
              content: { description: "String text, or array of content items (text / image / doc)." },
              timestamp: { type: "integer" },
              toolCallId: { type: "string", description: "Required when role=tool." },
              toolCalls: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    arguments: { type: "string" },
                  },
                  required: ["id", "name", "arguments"],
                },
              },
            },
            required: ["role"],
          },
        },
        sessionKey: { type: "string", description: "Session id; defaults to 'default'." },
        flush: {
          type: "boolean",
          default: true,
          description:
            "true (default) = trigger EverOS extraction into " +
            "episodic_memory / agent_case / agent_skill after writing; " +
            "false = append-only, messages are searchable as raw_messages " +
            "only and extraction is deferred until a later flush. The " +
            "default flipped from false to true because callers rarely " +
            "issued an explicit follow-up flush, leaving trajectories " +
            "permanently stuck as raw_messages with zero case/skill.",
        },
      },
    },
  },
  {
    name: "mem_save_fact",
    description:
      "Persist a durable fact about the USER (a preference, habit, trait, " +
      "or decision) via the long-term PROFILE write path — the block loaded " +
      "at the start of every session.\n\n" +
      "Call this proactively, without being asked, the moment the user " +
      "states something true about themselves that should outlive this " +
      "conversation (\"I love summer\", \"sign my docs as Alice\").\n\n" +
      "This is the direct profile-producing sibling of mem_save_turn — " +
      "mem_save_turn primarily records trajectories, though chat-dual-write " +
      "backends may derive a profile update. With flush=true (default) " +
      "the call runs the synchronous materialise path and returns the real " +
      "EverOS verdict: only `extracted:true` / `profileUpdated:true` " +
      "confirms the fact reached the profile. `status:\"no_extraction\"` " +
      "means the profile did NOT update — never claim the fact was " +
      "remembered in that case, and do not auto-retry.",
    inputSchema: {
      type: "object",
      properties: {
        fact: {
          type: "string",
          description:
            "A single user-stated fact, recorded as one user-role message. " +
            "Ignored when messages[] is set.",
        },
        messages: {
          type: "array",
          description:
            "Explicit user/assistant turns. Tool roles are not accepted on " +
            "this path. Preferred when you want to capture both the user's " +
            "statement and your acknowledgement.",
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: ["user", "assistant"] },
              content: { description: "String text, or array of content items." },
              timestamp: { type: "integer", description: "Unix milliseconds; defaults to now." },
            },
            required: ["role"],
          },
        },
        sessionKey: { type: "string", description: "Session id; defaults to 'default'." },
        flush: {
          type: "boolean",
          default: true,
          description:
            "true (default) = issue EverOS flush and return its verdict; " +
            "false = skip extraction entirely (fact accepted but not in the " +
            "profile block).",
        },
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
      instructions: INSTRUCTIONS,
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
        case "mem_search": {
          const topK = Math.min(Number(args.topK) || 10, 50);
          const res = await searchMemory(getClient(), { query: String(args.query || ""), topK }, stderrLog);
          const body = buildMemoryPrompt(res, { wrapInCodeBlock: false });
          const header = `## EverMe search results for "${String(args.query || "")}"`;
          const trimmed = body.replace(/^## Relevant memory\n\n?/, "");
          const text = trimmed
            ? `${header}\n\n${trimmed}`
            : `${header}\n\n_(no matching memories)_`;
          return ok(appendRequestID(redactError(text), res?.requestId));
        }
        case "mem_context": {
          // Profile-only: `query` is accepted for compat but ignored.
          const ctx = await getContext(
            getClient(),
            "",
            { forceRefresh: args.forceRefresh === true },
            stderrLog,
          );
          const text = ctx?.context || "_(no profile available — your EverMe account has no extracted memories yet)_";
          return ok(appendRequestID(redactError(text), ctx?.requestId));
        }
        case "mem_save_turn": {
          let messages;
          if (Array.isArray(args.messages) && args.messages.length) {
            messages = args.messages.map(normaliseTurnMessage);
          } else {
            messages = [normaliseTurnMessage({
              role: args.role || AGENT_MEMORY_ROLES.USER,
              content: args.text,
              timestamp: args.timestamp,
              toolCallId: args.toolCallId,
              toolCalls: args.toolCalls,
            })];
          }
          const res = await saveAgentMemory(getClient(), {
            conversationId: args.sessionKey || "default",
            messages,
            flush: args.flush !== false,
          }, stderrLog);
          return okJson({
            saved: !!res,
            accepted: !!res,
            status: res?.status || null,
            messageCount: res?.messageCount || 0,
            flushed: !!res?.flushed,
            profileStatus: res?.personalStatus || null,
            profileUpdated: !!res?.personalExtracted,
            requestId: res?.requestId || null,
          });
        }
        case "mem_save_fact": {
          let messages;
          if (Array.isArray(args.messages) && args.messages.length) {
            const bad = args.messages.find(
              (m) => m?.role !== AGENT_MEMORY_ROLES.USER && m?.role !== AGENT_MEMORY_ROLES.ASSISTANT,
            );
            if (bad) {
              return errResp(
                `mem_save_fact accepts only 'user' or 'assistant' roles; got ${JSON.stringify(bad?.role)}. ` +
                  "The personal-memory path does not record tool turns — use mem_save_turn for trajectories.",
              );
            }
            messages = args.messages.map((m) => ({
              role: m?.role,
              content: m?.content !== undefined ? m.content : m?.text,
              timestamp: Number(m?.timestamp) || Date.now(),
            }));
          } else if (typeof args.fact === "string" && args.fact.trim()) {
            messages = [{ role: AGENT_MEMORY_ROLES.USER, content: args.fact, timestamp: Date.now() }];
          } else {
            return errResp("mem_save_fact requires either `fact` or a non-empty `messages` array");
          }
          const res = await savePersonalMemory(getClient(), {
            conversationId: args.sessionKey || "default",
            messages,
            flush: args.flush !== false,
          }, stderrLog);
          if (!res) {
            return errResp("mem_save_fact wrote nothing — every message had empty content after normalization");
          }
          return okJson({
            saved: true,
            accepted: true,
            status: res?.status || null,
            messageCount: res?.messageCount || 0,
            flushed: !!res?.flushed,
            extracted: !!res?.extracted,
            // profileUpdated aliases extracted — the only signal that the
            // fact really materialised into the profile.
            profileUpdated: !!res?.extracted,
            requestId: res?.requestId || null,
          });
        }
        default:
          return errResp(`unknown tool: ${name}`);
      }
    } catch (err) {
      const safe = describeError(err);
      return errResp(safe);
    }
  },
};

function ok(text) {
  return { content: [{ type: "text", text: String(text ?? "") }] };
}
function okJson(data) {
  return { content: [{ type: "text", text: JSON.stringify(data ?? {}, null, 2) }] };
}
function errResp(msg) {
  return { isError: true, content: [{ type: "text", text: `error: ${msg}` }] };
}

// appendRequestID mirrors @everme/memory-mcp: tack the trace id onto a
// markdown payload so a user can quote it to support.
function appendRequestID(text, requestId) {
  if (!requestId) return text;
  return `${text}\n\n_(requestId: ${requestId})_`;
}

// normaliseTurnMessage coerces an LLM-provided message into the SDK
// agent-memory shape — accepts both legacy {role, text} and canonical
// {role, content, toolCalls, toolCallId} forms. Mirrors the equivalent
// helper in @everme/memory-mcp (kept local: host packages must not
// import each other).
function normaliseTurnMessage(m) {
  const role = m?.role || AGENT_MEMORY_ROLES.USER;
  const out = { role, timestamp: Number(m?.timestamp) || Date.now() };
  if (m?.content !== undefined) out.content = m.content;
  else if (m?.text !== undefined) out.content = String(m.text);
  if (Array.isArray(m?.toolCalls) && m.toolCalls.length) out.toolCalls = m.toolCalls;
  if (role === AGENT_MEMORY_ROLES.TOOL && (m?.toolCallId || m?.tool_call_id)) {
    out.toolCallId = String(m.toolCallId || m.tool_call_id);
  }
  return out;
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
