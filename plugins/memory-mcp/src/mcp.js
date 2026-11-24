/**
 * MCP server — exposes EverMe memory operations as MCP tools so any
 * MCP-speaking host (Claude Code, Cursor, etc.) can call them.
 *
 * Tools:
 *   mem_search           — full-text + vector hybrid query
 *   mem_context          — server-assembled context block for a prompt
 *   mem_skill            — full text of one agent skill, by id
 *
 * Read-only surface: saving is fully automatic via host hooks; the MCP
 * write tools (mem_save_turn / mem_save_fact) were retired.
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
export const PKG_VERSION =
  typeof __EVERME_MCP_VERSION__ === "string"
    ? __EVERME_MCP_VERSION__
    : createRequire(import.meta.url)("../package.json").version;

// Instructions surfaced via MCP `initialize.instructions`. Hosts that
// honour the field (Claude Desktop, Cursor, Codex at time of writing)
// splice this into their system prompt. One string serves every MCP host,
// and only some of them keep memory on their own (their hook runtime
// injects the <everme_profile> / <everme_recall> blocks); the copy keys
// its saving claim off that signal so a host with no writer behind this
// connection is never told to promise the user something was kept.
export const EVERME_MCP_INSTRUCTIONS = [
  "EverMe is the user's long-term memory across sessions.",
  "",
  "When a <everme_profile> or <everme_recall> block appears in your context,",
  "this host keeps that memory on its own: what matters in the conversation —",
  "preferences, decisions, the work you do together — is retained without",
  "anyone saving it by hand. If the user asks you to remember something, a",
  "short acknowledgement is enough (\"Noted — I'll remember that.\"); there is",
  "nothing to call and nothing to set up. If they ask how it works, \"EverMe",
  "keeps a memory of our conversations\" is the whole story from their side —",
  "the mechanics are not something to narrate.",
  "",
  "When neither block appears, this connection only reads EverMe memory.",
  "Whether the conversation is being kept is up to the host, so do not tell",
  "the user something has been saved through you.",
  "",
  "Three read tools bring memory into the conversation. Use them on your own",
  "judgment rather than waiting to be asked to \"recall\":",
  "1. START of a session — if no non-empty <everme_profile> block was injected, call `mem_context` once. It returns the user's durable Profile ONLY (no semantic search, no episodes, no raw transcript). Do not re-fetch it later in the session unless the user asks to refresh the profile.",
  "2. The user leans on earlier conversations, decisions, conventions, or previously solved problems — call `mem_search` with a SHORT query. Skip it when a non-empty, relevant <everme_recall> block is already in this turn, and never repeat an identical query in one turn. Rows under the provisional unextracted-transcript header are not yet extracted — treat them as a provisional transcript, never as established facts.",
  "",
  "3. A skill line in a recall block names an id and a one-line summary, not",
  "   the skill body. Call `mem_skill` with that id when the summary looks",
  "   like it applies to the task at hand; skip it when it does not.",
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
  "  mem://skill?id={id}       → one agent skill's full text (equivalent to mem_skill)",
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
const MEM_RESOURCE_SKILL_TEMPLATE = "mem://skill?id={id}";
const MEM_RESOURCE_DEFAULT_TOPK = 10;

import {
  resolveConfig,
  assertConfigUsable,
  createClient,
  redactError,
  describeError,
  searchMemory,
  getContext,
  buildMemoryPrompt,
  buildTimestampFilter,
  createSkillContentCache,
  extractUserIntent,
  formatQueryStats,
  brandOf,
  brandStrings,
} from "@everme/agent-sdk";

// Time-bound copy for mem_search. This wording is frozen public ABI: the same
// bytes live in plugins/claude-code/hooks/scripts/mcp-server.js and in
// server/internal/controller/mcphost/tools.go (memSearchSchema). Edit all
// three together, or the three surfaces stop agreeing on when a bound is
// warranted.
const START_TIME_DESCRIPTION = [
  "ISO 8601 lower bound on WHEN THE CONVERSATION HAPPENED — not when the thing",
  "being discussed happened. Example: 2026-09-09T00:00:00+08:00.",
  "",
  "Omit by default. Omitting costs you a few extra results you can ignore.",
  "Setting it wrongly costs you everything: a wrong bound returns zero rows,",
  "and zero rows is indistinguishable from a topic that was never discussed.",
  "When a bound is arguable, choose the wider window. If in doubt, leave it out.",
  "",
  "SET IT ONLY when the user named a window of conversation you can put exact",
  "dates on:",
  "  - an explicit date or range: \"Sep 3\", \"before Aug 20\", \"2026-09-08\",",
  "    \"late August to early September\"",
  "  - a calendar-relative word that resolves to exact dates against today:",
  "    \"yesterday\", \"the day before yesterday\", \"today\", \"last week\",",
  "    \"this month\", \"the last three days\", \"the past two weeks\"",
  "Resolve those against the current date and pass absolute values. Never pass",
  "the word \"yesterday\" itself.",
  "",
  "DO NOT SET IT in these three cases:",
  "",
  "1. Vague recency with no agreed boundary — \"recently\", \"lately\", \"a while",
  "   back\", \"earlier\", \"previously\", \"last time\", \"that other session\",",
  "   \"just now\". A duration makes a phrase datable (\"the last three days\");",
  "   a bare sense of recency does not (\"recently\"). Search unfiltered, and",
  "   re-run with a bound only if the results actually come back too old.",
  "",
  "2. A date that belongs to the SUBJECT rather than to the conversation.",
  "   \"Which year did I graduate\", \"which company was I at in 2020\", \"when did",
  "   this project start\", \"is the stack I chose last year still valid\" — every",
  "   one of these was discussed recently and must be searched unfiltered;",
  "   filtering by the event's year returns nothing.",
  "   This still holds when the user did discuss it at the time. \"The stack I",
  "   chose last year\" was probably decided in a conversation last year, but",
  "   the user is asking whether it still stands, and every later revision or",
  "   reversal is dated after that window. Bounding to last year hides exactly",
  "   the rows that answer the question.",
  "   Rule of thumb: a past tense describing the EVENT is not a filter. Only a",
  "   phrase describing WHEN YOU TWO TALKED is.",
  "",
  "3. A date-shaped string that is content, not a constraint — a version number",
  "   (\"v2026.09\"), a timestamp quoted from a log or stack trace, a cron",
  "   expression, a date format the user is asking how to parse. Put the string",
  "   in `query` instead of in a bound.",
].join("\n");

const END_TIME_DESCRIPTION = [
  "ISO 8601 upper bound. Same rules as startTime; must not be earlier than it.",
  "Either bound may be given alone: \"since Sep 1\" is startTime only, \"before",
  "Aug 20\" is endTime only. For a single day, span the whole day",
  "(T00:00:00 -> T23:59:59). Never set an endTime in the future: for \"today\" or",
  "\"this month\", pass startTime alone.",
  "",
  "Both bounds assume the user's local timezone when no offset is given; pass",
  "the offset explicitly when you can.",
].join("\n");

// mem_skill copy. Duplicated verbatim in
// plugins/claude-code/hooks/scripts/mcp-server.js — the two MCP surfaces are
// one public ABI (plugins/AGENTS.md 2), so edit both together.
const MEM_SKILL_DESCRIPTION = [
  "Read the FULL TEXT of one agent skill, addressed by the id printed in an",
  "\"Agent skills\" line of a recall block or of a mem_search result.",
  "",
  "Those lines carry the skill's name and a one-line summary only; the body —",
  "the actual steps, checks and decision points — is what this returns. Call it",
  "when a summary looks like it applies to the task in hand, and skip it when it",
  "does not: the summaries exist so you can make that call without paying for",
  "every body.",
  "",
  "The id must come from a search result seen in this session. Ids are not",
  "guessable, and one that was never retrieved here is reported as a miss —",
  "re-run mem_search rather than inventing an id.",
].join("\n");

const MEM_SKILL_ID_DESCRIPTION =
  "The skill id exactly as printed in the \"[skill <id>]\" prefix of an Agent skills line.";

const MEM_SKILL_MISSING_ID =
  "mem_skill requires an `id`: the value printed in the \"[skill <id>]\" prefix of an Agent skills line.";

// Honest miss. The body lives only in a /mem/search response — the gateway
// exposes no get-by-id — so the only recovery is another search, and saying so
// is more useful than any substitute text would be.
function skillCacheMiss(id) {
  return (
    `skill ${id} is not in this machine's local skill cache. ` +
    "Only skills returned by a recent search on this machine are cached, and entries expire. " +
    "Run mem_search again and use an id from its Agent skills lines."
  );
}

// The body is markdown already (EverOS writes it with its own headings), so it
// is passed through untouched under a heading that names what it is.
function renderSkill(skill) {
  const head = `## Agent skill: ${skill.name || "(unnamed skill)"}`;
  const meta = `_(id: ${skill.id}${skill.cachedAt ? `, cached ${skill.cachedAt}` : ""})_`;
  const parts = [head, meta];
  if (skill.description) parts.push(skill.description);
  parts.push(skill.content);
  return parts.join("\n\n");
}

// Appended to the `query` property: the two are coupled, and a time word left
// in the query dilutes the vector match it was already filtered on.
const QUERY_TIME_HYGIENE = [
  "When you set a time bound, strip the time words out of `query`. For",
  "\"what did we decide last Tuesday about the recall pipeline\", query is",
  "\"recall pipeline decision\" — \"last Tuesday\" belongs in startTime/endTime,",
  "and leaving it in the query dilutes the match.",
].join("\n");

/**
 * Build the MCP server. Returns the Server instance ready to connect to
 * a transport (the bin/ entry point pairs it with a StdioServerTransport).
 */
export function createMcpServer({ logger, config } = {}) {
  const log = logger || { info() {}, warn() {} };
  const cfg = resolveConfig({ ...(config || {}), clientKind: "mcp", clientVersion: PKG_VERSION });
  assertConfigUsable(cfg, { requireAgentId: config === undefined });

  const client = createClient(cfg, log);
  // Same default directory the hook processes write to (~/.everme/state, or
  // EVERME_STATE_DIR). That shared default is the whole mechanism: recall
  // runs in the hook process, mem_skill runs here.
  const skillCache = createSkillContentCache();

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
      instructions: brandStrings(EVERME_MCP_INSTRUCTIONS, brandOf(process.env)),
    },
  );

  // ---- Tool catalogue ------------------------------------------------

  server.setRequestHandler(ListToolsRequestSchema, async () => brandStrings({
    tools: [
      {
        name: "mem_search",
        description:
          "Search EverMe memory for entries relevant to a free-text query. " +
          "Returns the top-K matching entries (episodic, profile, agent " +
          "skills, recent raw transcript) rendered as markdown; rows " +
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
                "not the user's whole message, not a pasted file or log.\n\n" +
                QUERY_TIME_HYGIENE,
            },
            topK: { type: "integer", description: "Max entries to return", default: 10 },
            startTime: { type: "string", description: START_TIME_DESCRIPTION },
            endTime: { type: "string", description: END_TIME_DESCRIPTION },
          },
          required: ["query"],
        },
      },
      {
        name: "mem_skill",
        description: MEM_SKILL_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: { id: { type: "string", description: MEM_SKILL_ID_DESCRIPTION } },
          required: ["id"],
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
    ],
  }, brandOf(process.env)));

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
          // A malformed or reversed bound is a model mistake, not a server
          // fault: answer it as a tool error carrying the right shape so the
          // model can retry, instead of letting the RangeError kill the call.
          let filters;
          try {
            filters = buildTimestampFilter(args);
          } catch (err) {
            if (!(err instanceof RangeError)) throw err;
            return errResp(timeBoundHelp(err));
          }
          const res = await searchMemory(
            client,
            { query, topK: normalizeTopK(args.topK, cfg.topK || 10), filters, skillFetch: true },
            log,
          );
          return okMarkdown(
            appendRequestID(
              redactError(renderSearchResultsAsMarkdown(query, res) + appliedWindow(filters)),
              res?.requestId,
            ),
          );
        }

        case "mem_skill": {
          const id = String(args.id || "").trim();
          if (!id) return errResp(MEM_SKILL_MISSING_ID);
          const skill = await skillCache.read(id);
          // A miss is reported as a miss. There is no second source for a
          // skill body — the gateway has no get-by-id — so inventing one, or
          // answering with the summary as if it were the body, would hand the
          // model something that never existed.
          if (!skill) return errResp(skillCacheMiss(id));
          return okMarkdown(redactError(renderSkill(skill)));
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
          const rawText = ctx?.context || `_(no profile available — your ${brandName()} account has no extracted memories yet)_`;
          return okMarkdown(appendRequestID(redactError(rawText), ctx?.requestId));
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
  // Both the Tools and the Resources surface are now read-only (search +
  // context); saving is automatic via the host's hooks, so there is no
  // write tool to lack a Resource equivalent. Resources stay additive for
  // hosts (like Codex) whose bridge carries Resources but not Tools.

  server.setRequestHandler(ListResourcesRequestSchema, async () => brandStrings({
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
  }, brandOf(process.env)));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => brandStrings({
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
      {
        uriTemplate: MEM_RESOURCE_SKILL_TEMPLATE,
        name: "EverMe agent skill",
        description:
          "The full text of one agent skill, addressed by the id printed in " +
          "an \"Agent skills\" line. Read it when that line's summary looks " +
          "relevant to the task in hand. The id must come from a search " +
          "result in this session — ids are not guessable and an unknown one " +
          "is reported as a miss rather than approximated.",
        mimeType: "text/markdown",
      },
    ],
  }, brandOf(process.env)));

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
        throw new Error(`malformed ${brandName()} resource URI ${JSON.stringify(uri)}: ${parseErr.message}; expected mem://profile or mem://search?q=…`);
      }
      if (parsed.protocol !== "mem:") {
        throw new Error(`unknown ${brandName()} resource URI: ${uri} (supported scheme: mem://)`);
      }

      if (parsed.host === "profile") {
        // `query` is ignored by /mem/context — auth binds the agent.
        // Pass empty string to satisfy the SDK signature.
        const ctx = await getContext(client, "", {}, log);
        const rawText = ctx?.context || `_(no profile available — your ${brandName()} account has no extracted memories yet)_`;
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
        const res = await searchMemory(client, { query, topK, skillFetch: true }, log);
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
      if (parsed.host === "skill") {
        const id = String(parsed.searchParams.get("id") || "").trim();
        if (!id) throw new Error(`mem://skill requires a non-empty 'id' parameter; got URI: ${uri}`);
        const skill = await skillCache.read(id);
        // Throwing (rather than returning placeholder text) keeps a miss a
        // miss on this surface too — see the mem_skill dispatch.
        if (!skill) throw new Error(skillCacheMiss(id));
        return {
          contents: [{ uri, mimeType: "text/markdown", text: redactError(renderSkill(skill)) }],
        };
      }
      throw new Error(`unknown ${brandName()} resource URI: ${uri} (supported: mem://profile, mem://search?q=…, mem://skill?id=…)`);
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
    // Read-only server: nothing buffered to flush.
  }

  return { server, cfg, dispose };
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
// brandName is the product name in fixed text this server writes. Memory
// content is never rebranded.
function brandName() {
  return brandStrings("EverMe", brandOf(process.env));
}

function renderSearchResultsAsMarkdown(query, res) {
  // Rendering happens inside the MCP server process, so mem_skill is
  // necessarily reachable and a skill id is always redeemable.
  const body = buildMemoryPrompt(res, { wrapInCodeBlock: false, skillFetch: true });
  const header = `## ${brandName()} search results for "${query}"`;
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

// appliedWindow echoes the window that actually reached the gateway. When the
// model miscomputed a date it sees the consequence in the same response,
// instead of reading a silently emptied result set as "never discussed".
function appliedWindow(filters) {
  if (!filters?.timestamp) return "";
  const { gte, lte } = filters.timestamp;
  return `\n\n_Time filter applied: ${gte ?? "…"} → ${lte ?? "…"}_`;
}

// timeBoundHelp turns a buildTimestampFilter RangeError into copy the model
// can act on — the message alone does not say what a good value looks like.
function timeBoundHelp(err) {
  return `${err.message}. Pass ISO 8601 instants, e.g. startTime "2026-09-09T00:00:00+08:00" and endTime "2026-09-09T23:59:59+08:00"; omit both to search unfiltered.`;
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
