#!/usr/bin/env node
/**
 * MCP server bundled with the Claude Code plugin. Exposes the read-only
 * EverMe tools (mem_search / mem_context / mem_skill — the same public ABI as
 * @everme/memory-mcp and the Go hosted /mcp surface). Saving is automatic
 * via the plugin's hooks; the MCP write tools were retired.
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
  buildTimestampFilter,
  createClient,
  createSkillContentCache,
  getContext,
  searchMemory,
  redactError,
  describeError,
  EvermeError,
  brandOf,
  brandStrings,
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
// Same default directory the plugin's hooks write to (~/.everme/state, or
// EVERME_STATE_DIR). Recall runs in the hook process and mem_skill runs here,
// so that shared default is what makes the handoff work with no extra config.
const skillCache = createSkillContentCache();

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
  if (!client) client = createClient({ ...getConfig(), clientKind: "mcp", clientVersion: PKG_VERSION }, stderrLog);
  return client;
}

// Instructions returned on initialize — Claude Code splices them into the
// system prompt. The plugin's hooks always run on this host, so unlike the
// generic @everme/memory-mcp copy this one can state plainly that memory is
// kept on its own; the two READ tools cover what the injected
// <everme_profile> / <everme_recall> blocks do not.
const INSTRUCTIONS = [
  "EverMe is the user's long-term memory across sessions. On this host it",
  "listens to the conversation itself: what matters — preferences, decisions,",
  "the work you do together — is kept without anyone saving it by hand, and",
  "comes back into your context next time through the <everme_profile> and",
  "<everme_recall> blocks.",
  "",
  "So when the user asks you to remember something, you already can. A short",
  "acknowledgement is enough (\"Noted — I'll remember that.\"), then move on;",
  "there is nothing to call and nothing to set up. If they ask how it works,",
  "\"EverMe keeps a memory of our conversations\" is the whole story from their",
  "side — the mechanics are not something to narrate, and there is nothing to",
  "work around.",
  "",
  "Three read tools fill the gaps the injected blocks leave. Use them on your",
  "own judgment rather than waiting to be asked to \"recall\":",
  "1. The <everme_recall> block is missing, empty, or clearly off-topic AND the user leans on earlier conversations, decisions, conventions, or previously solved problems — call `mem_search` with a SHORT query, and never repeat an identical query in one turn.",
  "2. No <everme_profile> block was injected this session — call `mem_context` once. It returns the durable Profile ONLY (no search, no episodes).",
  "3. An Agent skills line names an id and a one-line summary, not the skill body — call `mem_skill` with that id when the summary looks like it applies to the task in hand.",
].join("\n");

// Time-bound copy for mem_search. This wording is frozen public ABI: the same
// bytes live in plugins/memory-mcp/src/mcp.js and in
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

// Appended to the `query` property: the two are coupled, and a time word left
// in the query dilutes the vector match it was already filtered on.
const QUERY_TIME_HYGIENE = [
  "When you set a time bound, strip the time words out of `query`. For",
  "\"what did we decide last Tuesday about the recall pipeline\", query is",
  "\"recall pipeline decision\" — \"last Tuesday\" belongs in startTime/endTime,",
  "and leaving it in the query dilutes the match.",
].join("\n");

// mem_skill copy. Duplicated verbatim in plugins/memory-mcp/src/mcp.js — the
// two MCP surfaces are one public ABI (plugins/AGENTS.md 2), so edit both
// together.
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

const TOOLS = [
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
];

// The brand comes from this plugin copy's credential file, which getConfig
// loads; an EverOS copy then says EverOS and uses the everos_* tags.
function currentBrand() {
  getConfig();
  return brandOf(process.env);
}

// brandName is the product name in fixed text this server writes. Memory
// content is never rebranded.
function brandName() {
  return brandStrings("EverMe", currentBrand());
}

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
      instructions: brandStrings(INSTRUCTIONS, currentBrand()),
    };
  },
  "tools/list": () => brandStrings({ tools: TOOLS }, currentBrand()),
  "tools/call": async (params) => {
    const name = params?.name;
    const args = params?.arguments || {};
    if (!isConfigured()) {
      return errResp(`${brandName()} not configured: set EVERME_API_KEY (emk) or EVERME_AGENT_TOKEN`);
    }
    try {
      switch (name) {
        case "mem_search": {
          const topK = Math.min(Number(args.topK) || 10, 50);
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
            getClient(),
            { query: String(args.query || ""), topK, filters, skillFetch: true },
            stderrLog,
          );
          // Rendering happens inside the MCP server process, so mem_skill is
          // necessarily reachable and a skill id is always redeemable.
          const body = buildMemoryPrompt(res, { wrapInCodeBlock: false, skillFetch: true });
          const header = `## ${brandName()} search results for "${String(args.query || "")}"`;
          const trimmed = body.replace(/^## Relevant memory\n\n?/, "");
          const text = trimmed
            ? `${header}\n\n${trimmed}`
            : `${header}\n\n_(no matching memories)_`;
          return ok(appendRequestID(redactError(text) + appliedWindow(filters), res?.requestId));
        }
        case "mem_skill": {
          const id = String(args.id || "").trim();
          if (!id) return errResp(MEM_SKILL_MISSING_ID);
          const skill = await skillCache.read(id);
          // A miss is reported as a miss: there is no second source for a
          // skill body, so answering with the summary — or with anything
          // invented — would hand the model text that never existed.
          if (!skill) return errResp(skillCacheMiss(id));
          return ok(redactError(renderSkill(skill)));
        }
        case "mem_context": {
          // Profile-only: `query` is accepted for compat but ignored.
          const ctx = await getContext(
            getClient(),
            "",
            { forceRefresh: args.forceRefresh === true },
            stderrLog,
          );
          const text = ctx?.context || `_(no profile available — your ${brandName()} account has no extracted memories yet)_`;
          return ok(appendRequestID(redactError(text), ctx?.requestId));
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

// appendRequestID mirrors @everme/memory-mcp: tack the trace id onto a
// markdown payload so a user can quote it to support.
function appendRequestID(text, requestId) {
  if (!requestId) return text;
  return `${text}\n\n_(requestId: ${requestId})_`;
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
