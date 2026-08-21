/**
 * MCP server — exposes EverMe memory operations as MCP tools so any
 * MCP-speaking host (Claude Code, Cursor, etc.) can call them.
 *
 * Tools:
 *   mem_search           — full-text + vector hybrid query
 *   mem_context          — server-assembled context block for a prompt
 *   mem_save_fact        — durable profile fact write
 *   mem_save_turn        — realtime write to /mem/agent-memory
 *
 * Build separately from bin/mcp-server.js so this file can be unit-tested
 * without binding stdio.
 */

import { createRequire } from "node:module";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Derive serverInfo.version from package.json so a release bump in
// bump.sh flows through to what we advertise on the MCP wire. The
// previous hard-coded "0.1.0" drifted from package.json on every
// publish.
const { version: PKG_VERSION } = createRequire(import.meta.url)("../package.json");

// Instructions surfaced via MCP `initialize.instructions`. Hosts that
// honour the field (Claude Desktop, Cursor, Codex at time of writing)
// splice this into their system prompt, so it doubles as the autonomy
// nudge that makes all four memory tools get
// called without the user having to ask.
export const EVERME_MCP_INSTRUCTIONS = [
  "EverMe memory is connected. Act on this protocol AUTONOMOUSLY: call these",
  "tools yourself the moment a trigger below fires — never wait for the user to",
  "ask you to \"remember\" or \"recall\".",
  "1. START of a session — if the host has NOT already injected a non-empty <everme_profile> block, call `mem_context` once. It returns the user's durable Profile ONLY (no semantic search, no episodes, no raw transcript). Never re-fetch it later in the session unless the user asks to refresh the profile.",
  "2. The user states a durable fact about themselves (a preference, habit, trait, long-term goal, or decision) — call `mem_save_fact` immediately, without being asked. Only `extracted:true` / `profileUpdated:true` in the result means the profile really updated; on `no_extraction` do NOT tell the user the fact was remembered, and do not auto-retry.",
  "3. A task was solved in a way worth reusing — call `mem_save_turn` with the COMPLETE trajectory (user → assistant tool calls → tool results → final answer). It feeds episodic / case / skill extraction; chat-dual-write backends may also update the Profile, reported by profileUpdated.",
  "4. The user references earlier conversations, decisions, conventions, or previously solved problems — call `mem_search` with a SHORT query. Skip it when the host already injected a non-empty, relevant <everme_recall> block this turn, and do not repeat an identical query in the same turn. Rows under the provisional unextracted-transcript header are not yet extracted — treat them as a provisional transcript, never as established facts.",
  "",
  "Keep the `mem_search` query short: a few keywords, NOT the whole",
  "conversation or the full user message pasted in — a long query searches",
  "worse and bloats the request. Rely on the default topK of 10; only raise it",
  "if a first search genuinely missed.",
  "",
  "If your host exposes MCP Resources (rather than Tools) to you, the same",
  "read data is available at these URIs — read them via `resources/read`:",
  "  mem://profile             → durable user Profile only (equivalent to mem_context)",
  "  mem://search?q={query}    → search results (equivalent to mem_search)",
  "Saving (mem_save_fact / mem_save_turn) has no Resource equivalent (MCP",
  "Resources are read-only); hosts that only expose Resources can recall but",
  "cannot auto-save.",
].join("\n");

// Resource URI constants. The static `mem://profile` URI is enumerated in
// resources/list; the search URI is a parameterised template enumerated
// in resources/templates/list (RFC 6570-style placeholders).
//
// Both URIs MUST be stable across releases — they're embedded in the
// EverMe Codex skill (plugins/codex-marketplace/plugins/everme/skills/
// everme-memory/SKILL.md) and any breaking change there silently breaks
// every host that follows the skill's guidance.
const MEM_RESOURCE_PROFILE_URI = "mem://profile";
const MEM_RESOURCE_SEARCH_TEMPLATE = "mem://search?q={query}&topK={topK}";
const MEM_RESOURCE_DEFAULT_TOPK = 10;

import {
  resolveConfig,
  assertConfigUsable,
  createClient,
  redactError,
  describeError,
  saveAgentMemory,
  savePersonalMemory,
  searchMemory,
  getContext,
  AGENT_MEMORY_ROLES,
  buildMemoryPrompt,
  extractUserIntent,
  formatQueryStats,
} from "@everme/agent-sdk";

/**
 * Build the MCP server. Returns the Server instance ready to connect to
 * a transport (the bin/ entry point pairs it with a StdioServerTransport).
 */
export function createMcpServer({ logger, config } = {}) {
  const log = logger || { info() {}, warn() {} };
  const cfg = resolveConfig(config || {});
  assertConfigUsable(cfg, { requireAgentId: config === undefined });

  const client = createClient(cfg, log);

  const server = new Server(
    { name: "everme-memory-mcp", version: PKG_VERSION },
    {
      capabilities: {
        tools: {},
        // Resources advertise the read-only view of EverMe memory for
        // hosts (notably Codex) that bridge MCP servers to the LLM via
        // resources/read instead of tools/call. We do NOT advertise
        // `subscribe` — push-based memory updates are out of V1.1 scope.
        resources: {},
      },
      instructions: EVERME_MCP_INSTRUCTIONS,
    },
  );

  // ---- Tool catalogue ------------------------------------------------

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
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
          "never performs semantic search and never returns episodic " +
          "memories, raw messages, agent cases, or agent skills.\n\n" +
          "Call it ONCE at the START of a session, and only when the host has " +
          "not already injected a non-empty <everme_profile> block. Do not " +
          "re-fetch it later in the session unless the user explicitly asks " +
          "to refresh the profile (pass forceRefresh=true then). Do NOT use " +
          "it as a fallback for recalling past decisions, old sessions, or " +
          "task context — that is mem_search's job.",
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
          "Does not create /mem/sources. Use sessionKey as conversationId.\n\n" +
          "Call this proactively — without being asked — when a task has been " +
          "solved in a way worth reusing, so future sessions can learn the " +
          "approach.\n\n" +
          "Two input forms:\n" +
          "  1. Single message — pass role + text (legacy); for assistant " +
          "messages that invoked tools, ALSO pass toolCalls so the tool round-" +
          "trip is preserved; for tool messages, pass toolCallId.\n" +
          "  2. Trajectory — pass messages: [{role, content, timestamp, " +
          "toolCalls?, toolCallId?}]. Use this when recording an end-to-end " +
          "user → assistant{tool_use} → tool → assistant cycle in one call; " +
          "EverOS only extracts agent_case / agent_skill from trajectories " +
          "that carry the full tool round-trip, so single-message-per-call " +
          "patterns silently produce zero case/skill upstream.\n\n" +
          "By default flush=true: the write triggers EverOS extraction into " +
          "episodic / agent_case / agent_skill right away. Pass flush=false " +
          "for append-only accumulation (messages land as raw_messages, " +
          "extraction deferred to a later flush) — e.g. when saving turn by " +
          "turn with a single flush at session end. The primary trajectory " +
          "path extracts episodic / case / skill memory; chat-dual-write " +
          "backends may also update the user's Profile. Check profileUpdated " +
          "for the derived profile verdict, and use mem_save_fact for " +
          "deliberate durable user facts.",
        inputSchema: {
          type: "object",
          properties: {
            // --- single-message form ---
            role: {
              type: "string",
              enum: [
                AGENT_MEMORY_ROLES.USER,
                AGENT_MEMORY_ROLES.ASSISTANT,
                AGENT_MEMORY_ROLES.TOOL,
              ],
              description: "Role for the single-message form. Ignored when messages[] is set.",
            },
            text: { type: "string", description: "Content for the single-message form. Ignored when messages[] is set." },
            timestamp: { type: "integer", description: "Unix milliseconds; defaults to now. Single-message form only." },
            toolCallId: { type: "string", description: "Required when role=tool. Single-message form only." },
            toolCalls: {
              type: "array",
              description:
                "Tool invocations made by an assistant message. Required when the " +
                "assistant called tools — without this the tool round-trip can never " +
                "be reconstructed downstream and EverOS will not produce agent_case / " +
                "agent_skill from the turn.",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  arguments: {
                    type: "string",
                    description: "JSON-encoded tool arguments (stringified, not an object).",
                  },
                },
                required: ["id", "name", "arguments"],
              },
            },

            // --- trajectory form ---
            messages: {
              type: "array",
              description:
                "Multi-message trajectory. Preferred for recording a complete " +
                "user → assistant{tool_use} → tool{tool_result} → assistant cycle.",
              items: {
                type: "object",
                properties: {
                  role: {
                    type: "string",
                    enum: [
                      AGENT_MEMORY_ROLES.USER,
                      AGENT_MEMORY_ROLES.ASSISTANT,
                      AGENT_MEMORY_ROLES.TOOL,
                    ],
                  },
                  content: {
                    description: "String text, or array of content items (text / image / doc).",
                  },
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
          "Persist a durable fact about the USER (a preference, habit, " +
          "trait, or decision) via the long-term PROFILE write path — the " +
          "block loaded at the start of every session.\n\n" +
          "Call this proactively, without being asked, the moment the user " +
          "states something true about themselves that should outlive this " +
          "conversation (\"I love summer\", \"I take my coffee iced\", " +
          "\"sign my docs as Alice\").\n\n" +
          "This is the direct profile-producing sibling of mem_save_turn. " +
          "They are NOT interchangeable: mem_save_turn primarily records " +
          "conversation trajectories (→ episodic / agent_case / agent_skill), " +
          "though chat-dual-write backends may derive a profile update; " +
          "mem_save_fact writes plain user/assistant " +
          "turns to the personal-memory path (→ profile + episodic) and does " +
          "NOT carry tool calls. For a stated user fact, prefer this tool.\n\n" +
          "Pass either `fact` (a single statement) OR `messages` " +
          "[{role:'user'|'assistant', content, timestamp?}]. With flush=true " +
          "(default) the call runs the synchronous materialise path and " +
          "returns the real EverOS verdict: `status:\"no_extraction\"` and " +
          "`extracted:false` / `profileUpdated:false` mean the profile did " +
          "NOT update even though the tool call itself succeeded — never " +
          "tell the user the fact was remembered in that case, and do not " +
          "auto-retry. Only `extracted:true` / `profileUpdated:true` " +
          "confirms the fact reached the profile. (flush:false skips " +
          "extraction entirely — rarely what you want.)",
        inputSchema: {
          type: "object",
          properties: {
            fact: {
              type: "string",
              description:
                "A single user-stated fact, recorded as one user-role " +
                "message. Ignored when messages[] is set.",
            },
            messages: {
              type: "array",
              description:
                "Explicit user/assistant turns. Tool roles are not accepted " +
                "on this path. Preferred when you want to capture both the " +
                "user's statement and your acknowledgement.",
              items: {
                type: "object",
                properties: {
                  role: {
                    type: "string",
                    enum: [AGENT_MEMORY_ROLES.USER, AGENT_MEMORY_ROLES.ASSISTANT],
                  },
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
                "false = skip extraction entirely (fact accepted but not in " +
                "the profile block).",
            },
          },
        },
      },
    ],
  }));

  // ---- Tool dispatch -------------------------------------------------

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments || {};
    try {
      switch (name) {
        case "mem_search": {
          // Return markdown directly — matching the Resources path
          // (mem://search). Earlier versions JSON.stringify'd the raw
          // searchMemory bundle, forcing the host LLM to peel a JSON
          // envelope before the markdown was readable. The bundle's raw
          // field names (embed_text, contentItems, taskIntent) are also
          // not LLM-friendly without buildMemoryPrompt's rendering.
          // The query is model-authored, so the prose in the tool description
          // is a request, not a guarantee: models do paste whole transcripts.
          // Extract the intent (strips host blocks, folds pastes, keeps the
          // tail) and log the reduction, so a host that keeps over-sending is
          // visible instead of silently tanking recall relevance.
          const { query, stats } = extractUserIntent(args.query);
          log.info?.(`[everme] mem_search query: ${formatQueryStats(stats)}`);
          const res = await searchMemory(
            client,
            { query, topK: normalizeTopK(args.topK, cfg.topK || 10) },
            log,
          );
          return okMarkdown(
            appendRequestID(redactError(renderSearchResultsAsMarkdown(query, res)), res?.requestId),
          );
        }

        case "mem_context": {
          // Body accepts only { forceRefresh? }; agent is bound from auth.
          // `query` is accepted for backwards compatibility but ignored —
          // the endpoint is Profile-only and never searches.
          // Returns raw markdown for the same reason as mem_search above
          // — getContext already pre-renders into ctx.context, so the
          // earlier JSON.stringify({context, memoryCount, ...}) wrapping
          // was pure noise the LLM had to unwrap.
          const ctx = await getContext(client, "", { forceRefresh: args.forceRefresh === true }, log);
          const rawText = ctx?.context || "_(no profile available — your EverMe account has no extracted memories yet)_";
          return okMarkdown(appendRequestID(redactError(rawText), ctx?.requestId));
        }

        case "mem_save_turn": {
          // Trajectory form takes precedence over single-message form
          // when both are supplied — explicit messages[] is always the
          // richer signal, and a host that builds both probably wants
          // the trajectory.
          let messages;
          if (Array.isArray(args.messages) && args.messages.length) {
            messages = args.messages.map((m) => normaliseMemMessage(m));
          } else {
            messages = [
              normaliseMemMessage({
                role: args.role || AGENT_MEMORY_ROLES.USER,
                content: args.text,
                timestamp: args.timestamp,
                toolCallId: args.toolCallId,
                toolCalls: args.toolCalls,
              }),
            ];
          }
          const res = await saveAgentMemory(
            client,
            {
              conversationId: args.sessionKey || "default",
              messages,
              // Default-true: only an EXPLICIT `flush: false` keeps writes
              // append-only. Matches the schema default above and the
              // historical-bug rationale (callers forget to follow up
              // with a flush, data sits as raw_message forever).
              flush: args.flush !== false,
            },
            log,
          );
          return ok({
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
          // messages[] takes precedence over the single `fact` shorthand —
          // a caller that built both probably wants the richer turn pair.
          let messages;
          if (Array.isArray(args.messages) && args.messages.length) {
            // Reject unexpected roles loudly rather than coercing them: a
            // tool turn (or a typo'd role) silently rewritten into a
            // user-attributed profile fact is a correctness bug. The
            // personal-memory path is user/assistant only.
            const bad = args.messages.find(
              (m) => m?.role !== AGENT_MEMORY_ROLES.USER && m?.role !== AGENT_MEMORY_ROLES.ASSISTANT,
            );
            if (bad) {
              return errResp(
                `mem_save_fact accepts only 'user' or 'assistant' roles; got ${JSON.stringify(bad?.role)}. ` +
                  "The personal-memory path does not record tool turns — use mem_save_turn for trajectories.",
              );
            }
            messages = args.messages.map((m) => normalisePersonalMessage(m));
          } else if (typeof args.fact === "string" && args.fact.trim()) {
            messages = [{ role: AGENT_MEMORY_ROLES.USER, content: args.fact, timestamp: Date.now() }];
          } else {
            return errResp("mem_save_fact requires either `fact` or a non-empty `messages` array");
          }
          const res = await savePersonalMemory(
            client,
            {
              conversationId: args.sessionKey || "default",
              messages,
              // Default-true so the profile materialises now — see schema.
              flush: args.flush !== false,
            },
            log,
          );
          // savePersonalMemory returns null when every message had empty
          // content (nothing reached the backend). Surface that as an error,
          // not a saved:false "success" the LLM might report as done.
          if (!res) {
            return errResp("mem_save_fact wrote nothing — every message had empty content after normalization");
          }
          return ok({
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
      // Always go through redactError. EvermeError already redacts in
      // its constructor, but callers can throw plain Error / TypeError
      // / fetch errors whose .message may carry presigned-URL signing
      // params, evt tokens, etc. The host LLM sees this text verbatim
      // — so the scrub MUST run here, not just in EvermeError.
      const safe = describeError(err);
      log.warn?.(`[everme-mcp] tool ${name} failed: ${safe}`);
      return errResp(safe);
    }
  });

  // ---- Resources surface ---------------------------------------------
  //
  // Why we ship Resources in addition to Tools:
  //
  // Codex App (≥ v0.128, observed via real install on 2026-05-26)
  // bridges MCP to the LLM only through resources/read — it does NOT
  // expose tools/call as model-callable functions. So even though our
  // four tools are registered and visible in Codex's /mcp panel, the
  // LLM can't invoke them. The Resources surface below gives the same
  // read-side data via URIs Codex's bridge can actually carry.
  //
  // Trade-off vs Tools: Resources are read-only by protocol, so there's
  // no Resource equivalent for mem_save_turn. Codex users get auto-
  // recall but not auto-save in this iteration; saving stays a Tool.
  // Other hosts (Claude Code, Cursor, Claude Desktop) continue using
  // Tools as before — Resources are additive, not a replacement.

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: MEM_RESOURCE_PROFILE_URI,
        name: "EverMe user profile",
        description:
          "The user's durable Profile snapshot ONLY — preferences, habits, " +
          "traits, and long-term decisions known across sessions. It never " +
          "contains episodic memories, raw messages, agent cases, or agent " +
          "skills, and reading it never performs semantic search. Read it " +
          "once at the start of a conversation when no <everme_profile> " +
          "block was injected; use mem://search for historical recall.",
        mimeType: "text/markdown",
      },
    ],
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: MEM_RESOURCE_SEARCH_TEMPLATE,
        name: "EverMe semantic search",
        description:
          "Search EverMe memory for entries relevant to a free-text " +
          "query. Use when the user references prior conversations " +
          "(\"what did we say about X\", \"remember when…\"). " +
          "topK defaults to 10; omit to use the default.",
        mimeType: "text/markdown",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req?.params?.uri || "";
    try {
      // Route by the URI's `host` segment instead of string match: this
      // collapses benign variants (trailing slash, fragment, cache-bust
      // querystring `mem://profile?_=1`) onto the same handler without
      // turning startsWith into a footgun that accepts e.g.
      // `mem://searchfoo`. The URL parser also gives a clean error
      // message for genuinely malformed URIs that `new URL` rejects.
      let parsed;
      try {
        parsed = new URL(uri);
      } catch (parseErr) {
        throw new Error(`malformed EverMe resource URI ${JSON.stringify(uri)}: ${parseErr.message}; expected mem://profile or mem://search?q=…`);
      }
      if (parsed.protocol !== "mem:") {
        throw new Error(`unknown EverMe resource URI: ${uri} (supported scheme: mem://)`);
      }

      if (parsed.host === "profile") {
        // `query` is ignored by /mem/context — auth binds the agent.
        // Pass empty string to satisfy the SDK signature.
        const ctx = await getContext(client, "", {}, log);
        const rawText = ctx?.context || "_(no profile available — your EverMe account has no extracted memories yet)_";
        // Defense-in-depth: backend may have leaked an evt_/emk_ secret
        // into profile text if the user once pasted one in chat.
        // redactError() (agent-sdk/src/client.js) scrubs both patterns
        // plus S3 signing params. agt_ ids are public (they appear in
        // plugin list output and the config file) so they are NOT
        // scrubbed.
        const text = redactError(rawText);
        return {
          contents: [{ uri, mimeType: "text/markdown", text }],
        };
      }
      if (parsed.host === "search") {
        // Default topK falls back to cfg.topK (same source the
        // mem_search tool uses on line ~261), so Resources and Tools
        // surfaces return the same number of results for an unqualified
        // query. Hard-coding MEM_RESOURCE_DEFAULT_TOPK here would
        // diverge from `cfg.topK` for deployments that customize it.
        const { query, topK } = parseMemSearchURI(uri, cfg.topK);
        if (!query) {
          // Empty query is meaningless for semantic search. Surface a
          // gentle error rather than firing a backend call that returns
          // nothing useful.
          throw new Error(`mem://search requires non-empty 'q' parameter; got URI: ${uri}`);
        }
        const res = await searchMemory(client, { query, topK }, log);
        return {
          contents: [{
            uri,
            mimeType: "text/markdown",
            // Same redaction story as mem://profile above — search
            // results carry user-saved content and we should never
            // surface a raw secret to the LLM even if one slipped past
            // the backend.
            text: redactError(renderSearchResultsAsMarkdown(query, res)),
          }],
        };
      }
      throw new Error(`unknown EverMe resource URI: ${uri} (supported: mem://profile, mem://search?q=…)`);
    } catch (err) {
      // Same redaction policy as tools/call: presigned URL signing
      // params and evt tokens can leak into upstream error messages,
      // and resources/read text is shown verbatim to the LLM (and
      // sometimes the human via host UI).
      const safe = describeError(err);
      log.warn?.(`[everme-mcp] resources/read ${uri} failed: ${safe}`);
      // Re-throw so the SDK converts to a JSON-RPC error envelope
      // (-32603 internal error or -32602 invalid params depending on
      // shape). Returning a fake "success" with an error message in
      // text would mislead hosts that check for response.isError.
      throw new Error(safe);
    }
  });

  async function dispose() {
    // No buffered runtime writes: mem_save_turn is synchronous.
  }

  return { server, cfg, dispose };
}

// normaliseMemMessage coerces an LLM-provided message into the SDK
// agent-memory shape. Accepts both legacy {role, text} and the
// canonical {role, content, toolCalls, toolCallId} forms so a host
// LLM can call either way without trial-and-error. content is left
// as-is (string OR array of content items) so the SDK's
// convertAssistant can re-flatten when needed.
function normaliseMemMessage(m) {
  const role = m?.role || AGENT_MEMORY_ROLES.USER;
  const out = {
    role,
    timestamp: Number(m?.timestamp) || Date.now(),
  };
  if (m?.content !== undefined) out.content = m.content;
  else if (m?.text !== undefined) out.content = String(m.text);
  if (Array.isArray(m?.toolCalls) && m.toolCalls.length) out.toolCalls = m.toolCalls;
  if (role === AGENT_MEMORY_ROLES.TOOL && (m?.toolCallId || m?.tool_call_id)) {
    out.toolCallId = String(m.toolCallId || m.tool_call_id);
  }
  return out;
}

// normalisePersonalMessage coerces an LLM-provided message into the shape
// savePersonalMemory expects (accepting legacy {role, text} alongside
// {role, content}). It deliberately does NOT carry tool roles / toolCalls /
// toolCallId — the personal-memory path is user/assistant only. The role is
// passed through verbatim rather than coerced: the SDK's
// convertPersonalMessage drops any non-{user,assistant} role, so a stray
// tool message is filtered out instead of being silently rewritten into a
// user-attributed profile fact.
function normalisePersonalMessage(m) {
  const out = { role: m?.role, timestamp: Number(m?.timestamp) || Date.now() };
  if (m?.content !== undefined) out.content = m.content;
  else if (m?.text !== undefined) out.content = String(m.text);
  return out;
}

// Exported for unit tests. Production callers use these via the
// resources/read handler — the export only exists so tests can pin URI
// parsing and markdown rendering in isolation without spinning up the
// EverMe HTTP backend.
export { parseMemSearchURI, renderSearchResultsAsMarkdown, normalizeTopK };

// MEM_RESOURCE_TOPK_MAX caps the topK an LLM-templated URI can ask for.
// Without a ceiling, `mem://search?q=…&topK=9999` would fetch and
// render thousands of rows — easy way to blow past the host's MCP
// content limit, stdio frame size, and the model's context window.
// 50 is generous for an LLM-side recall step.
const MEM_RESOURCE_TOPK_MAX = 50;

// normalizeTopK coerces a JSON-arg topK to a sane positive integer,
// falling back to `fallback` for null/undefined/0/negative/non-integer.
// `??` alone falls back only on null/undefined — a host LLM that
// templates `{topK: 0}` (a common default-numeric mistake) would
// otherwise pass 0 to /mem/search and get an empty bundle, indistinguishable
// from a real "no matching memories" miss. Mirrors the `n > 0` guard in
// parseMemSearchURI so the Tools and Resources surfaces behave the same.
function normalizeTopK(value, fallback, max = MEM_RESOURCE_TOPK_MAX) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

// parseMemSearchURI extracts `q` and `topK` from a `mem://search?...`
// URI. Strictly parses topK as `^\d+$` (whitespace-stripped) so values
// like `topK=1e2` or `topK=5xyz` fall back to the default instead of
// being silently truncated by parseInt's prefix-eating semantics
// (`parseInt('1e2',10) === 1`, `parseInt('5xyz',10) === 5`). Query is
// trimmed and `q=&query=foo` falls back to `query` only when `q` is
// truly absent — empty present-but-empty `q=` is preserved as empty
// (the caller rejects empty queries with a useful error).
//
// Aliases: accepts `q` / `query`, and `topK` / `top_k` — LLMs guess
// the casing inconsistently across templating attempts.
//
// `defaultTopK` lets the caller (handler) thread cfg.topK in so the
// Resources surface returns the same number of results as the
// equivalent mem_search Tool call. The exported test calls it without
// the argument, in which case we fall back to the shared default of 10.
function parseMemSearchURI(uri, defaultTopK) {
  const u = new URL(uri);
  const sp = u.searchParams;
  const qPresent = sp.has("q");
  const rawQ = qPresent ? sp.get("q") : sp.get("query") || "";
  const query = String(rawQ || "").trim();
  const topKRaw = (sp.get("topK") || sp.get("top_k") || "").trim();
  let topK = Number.isFinite(defaultTopK) && defaultTopK > 0
    ? defaultTopK
    : MEM_RESOURCE_DEFAULT_TOPK;
  if (/^\d+$/.test(topKRaw)) {
    const n = Number(topKRaw);
    if (n > 0) topK = n;
  }
  // Always clamp — the cfg-default or LLM-supplied value could exceed
  // the renderer / context budget. MEM_RESOURCE_TOPK_MAX is the hard
  // ceiling.
  topK = Math.min(topK, MEM_RESOURCE_TOPK_MAX);
  return { query, topK };
}

// renderSearchResultsAsMarkdown delegates to agent-sdk's canonical
// buildMemoryPrompt — that one already knows the real field names for
// each row type (episode for memories, profileData.embed_text for
// profiles, contentItems[] for rawMessages, taskIntent for cases) and
// has rawMessageText() that unwraps the assistant message parts array
// instead of String()-ing it into "[object Object]".
//
// Earlier this file shipped a hand-rolled renderer that fell back to
// `row?.text || row?.description || row?.content || JSON.stringify(row)`,
// which matched no real searchMemory response and produced wall-of-JSON
// output in production. buildMemoryPrompt is the source of truth for
// search-result markdown rendering across OpenClaw + MCP and now here.
function renderSearchResultsAsMarkdown(query, res) {
  const body = buildMemoryPrompt(res, { wrapInCodeBlock: false });
  const header = `## EverMe search results for "${query}"`;
  if (!body) return `${header}\n\n_(no matching memories)_`;
  // buildMemoryPrompt emits its own "## Relevant memory" header. Strip
  // it so we don't double-render headers; keep the section subheadings
  // and bullets verbatim.
  const trimmed = body.replace(/^## Relevant memory\n\n?/, "");
  return `${header}\n\n${trimmed}`;
}

function ok(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data ?? {}, null, 2) }],
  };
}

// okMarkdown is the read-side counterpart to ok(): for tools whose
// payload IS the markdown the LLM should splice into its prompt
// (mem_search, mem_context), we return the text raw instead of
// double-wrapping it in a JSON envelope the LLM has to peel. Matches
// the contents[].text shape on the Resources surface so a host that
// can pick either path sees the same string either way.
function okMarkdown(text) {
  return {
    content: [{ type: "text", text: String(text ?? "") }],
  };
}

// appendRequestID tacks the trace id onto a markdown payload so a user can
// quote it to support; empty ids (test stubs, degraded paths) add nothing.
function appendRequestID(text, requestId) {
  if (!requestId) return text;
  return `${text}\n\n_(requestId: ${requestId})_`;
}

// errResp accepts pre-redacted text. Callers MUST run redactError on
// any non-EvermeError input before passing it in (the catch block
// above does this; if you add another caller, do the same).
function errResp(msg) {
  return {
    isError: true,
    content: [{ type: "text", text: `error: ${msg}` }],
  };
}
