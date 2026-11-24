/**
 * Claude Code transcript reader.
 *
 * Stop / SessionEnd hooks receive `transcript_path` on stdin — a JSONL
 * file Claude Code writes per session. Each line is one event; we
 * parse selectively into the message shape EverMe wants:
 *
 *   { role, text, ts, hasToolCall }
 *   { role, timestamp, content, toolCalls?, toolCallId? } for realtime writes
 *
 * `hasToolCall` is retained for legacy markdown rendering tests. Runtime
 * persistence uses extractAgentMessages so tool calls/results can go directly
 * to /mem/agent-memory.
 */

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { AGENT_MEMORY_ROLES, AGENT_MEMORY_TOOL_CALL_TYPES, humanTextFromWrappers } from "@everme/agent-sdk";

const READ_RETRIES = 5;
const RETRY_DELAY_MS = 100;

/**
 * Read the transcript with a small retry budget. Stop hook can fire
 * before Claude Code has flushed the final line; we wait for the
 * `turn_duration` marker which Claude Code writes when the turn is
 * complete.
 *
 * Async IO: hooks run in their own short-lived Node process, but
 * transcripts can grow to several MB and the previous synchronous
 * `readFileSync` blocked the event loop for the entire read on each
 * of the 5 retries. Using fs.promises.readFile lets the loop service
 * other tasks (timer for sleep, GC) between retries. The retry budget
 * itself is unchanged.
 */
export async function readTranscript(path) {
  if (!path || !existsSync(path)) return [];
  for (let i = 0; i < READ_RETRIES; i++) {
    // readFile errors must NOT escape this function. The Stop hook
    // installs a process-wide unhandledRejection handler that exits 0
    // silently — an ENOENT here (the transcript file was rotated /
    // removed mid-read) used to fall into that catch-all and the
    // entire Stop write was silently dropped. Treating ENOENT as
    // "transient, retry" and other fs errors as "give up, return []"
    // surfaces the right signal: zero lines means no Stop work to do.
    let raw;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT" && i < READ_RETRIES - 1) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      return [];
    }
    const lines = raw.trim().split("\n").filter(Boolean);
    if (lines.length === 0) {
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    let complete = false;
    try {
      const last = JSON.parse(lines[lines.length - 1]);
      if (last?.type === "turn_duration" || last?.event === "turn_duration") {
        complete = true;
      }
    } catch {
      /* incomplete line — retry */
    }
    if (complete || i === READ_RETRIES - 1) return lines;
    await sleep(RETRY_DELAY_MS);
  }
  return [];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Walk the JSONL events and produce the {role, text, hasToolCall, ts}
 * sequence the hooks need. Robust to Claude Code's evolving transcript
 * shape — we only consume the fields we recognise and silently skip
 * unknown event kinds.
 */
export function extractTurns(lines) {
  const turns = [];
  for (const line of lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    // User-side prompt
    if (ev.role === AGENT_MEMORY_ROLES.USER && typeof ev.content === "string") {
      turns.push({
        role: AGENT_MEMORY_ROLES.USER,
        text: ev.content,
        ts: ev.timestamp || Date.now(),
        hasToolCall: false,
      });
      continue;
    }
    // Assistant message — content can be a string or an array of
    // content blocks (text / tool_use / tool_result).
    if (ev.role === AGENT_MEMORY_ROLES.ASSISTANT) {
      const { text, hasToolCall } = flattenAssistant(ev.content);
      if (text) {
        turns.push({
          role: AGENT_MEMORY_ROLES.ASSISTANT,
          text,
          ts: ev.timestamp || Date.now(),
          hasToolCall,
        });
      }
      continue;
    }
    // Tool result event — Claude Code emits these as a separate role.
    if (ev.role === AGENT_MEMORY_ROLES.TOOL || ev.type === "tool_result") {
      const tr =
        typeof ev.content === "string"
          ? ev.content
          : safeJsonStringify(ev.content);
      turns.push({
        role: AGENT_MEMORY_ROLES.TOOL,
        text: tr,
        ts: ev.timestamp || Date.now(),
        hasToolCall: true,
      });
    }
  }
  return turns;
}

export function extractAgentMessages(lines, { subagent = false, diagnostic = () => {} } = {}) {
  const messages = [];
  const dropped = { calls: 0, results: 0 };
  for (const line of lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (isInternalEvent(ev, subagent)) continue;
    const timestamp = normalizeTimestamp(ev.timestamp);
    // Real Claude Code transcript schema is nested: each line is
    //   { "type":"user"|"assistant", "message":{role, content}, ... }
    // with content.string OR content[]={text|thinking|tool_use|tool_result}.
    // Tool results live INSIDE a user-role envelope (with content[].type=tool_result
    // carrying tool_use_id). The legacy flat-shape fixture (top-level
    // ev.role + ev.content) is accepted as a fallback so existing tests
    // and any external producers keep working.
    const inner = ev.message && typeof ev.message === "object" ? ev.message : null;
    const role = inner?.role ?? ev.role;
    const rawContent = inner?.content ?? ev.content;

    if (role === AGENT_MEMORY_ROLES.USER) {
      // Split the user envelope: tool_result blocks become role=tool
      // messages (with their own toolCallId), free text becomes a
      // role=user message. A single CC user event can therefore emit
      // multiple EverMe messages.
      const toolResults = extractToolResults(rawContent, timestamp, dropped);
      messages.push(...toolResults);
      if (subagent) continue;
      const text = normalizeClaudeUserText(textFromContent(rawContent));
      if (!text) continue;
      // Earlier releases uploaded these records as user turns. They keep
      // their turn as an empty placeholder so checkpoints and the gate's turn
      // watermark line up across the upgrade; the text never leaves.
      const human = isHumanAuthored(ev) && !isHostEventText(text, ev) ? humanTextFromWrappers(text) : "";
      if (!human) {
        messages.push({ role: AGENT_MEMORY_ROLES.USER, timestamp, content: "", placeholder: true });
        continue;
      }
      messages.push({ role: AGENT_MEMORY_ROLES.USER, timestamp, content: human });
      continue;
    }
    if (role === AGENT_MEMORY_ROLES.ASSISTANT) {
      const msg = agentAssistantMessage(rawContent, timestamp, dropped);
      if (msg) {
        if (inner?.stop_reason === "end_turn") msg.turnComplete = true;
        messages.push(msg);
      }
      continue;
    }
    // Legacy flat tool-role fallback: { role:"tool", content, toolCallId }
    if (role === AGENT_MEMORY_ROLES.TOOL || ev.type === "tool_result") {
      const toolCallId = firstToolId(ev.toolCallId, ev.tool_call_id, ev.tool_use_id);
      if (!toolCallId) {
        dropped.results++;
        continue;
      }
      const content =
        typeof rawContent === "string" ? rawContent : safeJsonStringify(rawContent);
      messages.push({ role: AGENT_MEMORY_ROLES.TOOL, timestamp, toolCallId, content });
    }
  }
  const filtered = filterInvalidToolCalls(messages, diagnostic);
  if (dropped.calls || dropped.results) {
    diagnostic(`[everme] claude-code parse lines=${lines.length} messages=${filtered.length} dropped_invalid_call_id=${dropped.calls} dropped_invalid_result_id=${dropped.results}`.slice(0, 1024));
  }
  return filtered;
}

function filterInvalidToolCalls(messages, diagnostic) {
  const callCounts = new Map();
  const invalidCalls = new Set();
  const invalidIds = new Map();
  const dropped = {
    invalid_tool_name: { calls: 0, results: 0 },
    invalid_tool_arguments: { calls: 0, results: 0 },
  };
  for (const message of messages) {
    for (const call of message.toolCalls || []) {
      callCounts.set(call.id, (callCounts.get(call.id) || 0) + 1);
      const reason = invalidToolCallReason(call);
      if (reason) {
        invalidCalls.add(call);
        invalidIds.set(call.id, reason);
        dropped[reason].calls++;
      }
    }
  }
  if (!invalidCalls.size) return messages;
  const filtered = [];
  for (const message of messages) {
    if (message.role === AGENT_MEMORY_ROLES.TOOL
      && invalidIds.has(message.toolCallId) && callCounts.get(message.toolCallId) === 1) {
      dropped[invalidIds.get(message.toolCallId)].results++;
      continue;
    }
    if (message.toolCalls?.some(call => invalidCalls.has(call))) {
      const kept = { ...message, toolCalls: message.toolCalls.filter(call => !invalidCalls.has(call)) };
      if (!kept.toolCalls.length) {
        delete kept.toolCalls;
        if (!kept.content?.trim()) continue;
      }
      filtered.push(kept);
    } else {
      filtered.push(message);
    }
  }
  for (const [reason, counts] of Object.entries(dropped)) {
    if (counts.calls) diagnostic(`[everme] claude-code parse reason=${reason} dropped_calls=${counts.calls} dropped_results=${counts.results}`.slice(0, 1024));
  }
  return filtered;
}

function invalidToolCallReason(call) {
  if (typeof call.name !== "string" || !call.name.trim()) return "invalid_tool_name";
  return isJsonArguments(call.arguments) ? "" : "invalid_tool_arguments";
}

function isJsonArguments(value) {
  if (typeof value !== "string") return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function firstToolId(...values) {
  return values.find(value => typeof value === "string" && value.trim().length > 0) || "";
}

// Claude Code also writes enveloped records that are not turns: an
// api-request-blob replays slices of the request it sent (history copies,
// "Tool loaded.", system context) under role=user/assistant/system. Only
// user and assistant records are the conversation.
const CONTENT_TYPES = new Set(["user", "assistant"]);

function isInternalEvent(event, subagent) {
  if (event?.message && typeof event.message === "object"
      && typeof event.type === "string" && !CONTENT_TYPES.has(event.type)) return true;
  if (event?.isMeta === true) return true;
  if (subagent) return false;
  return event?.isSidechain === true
    || (typeof event?.agentId === "string" && event.agentId.length > 0);
}

// Claude Code stamps the source of each user record in origin.kind. Only the
// kinds its own writers use for machine-made turns are excluded; any other
// kind, and records from before the field existed, stay the person's words.
const NON_HUMAN_ORIGINS = new Set(["task-notification", "auto-continuation", "peer", "coordinator", "observer-activity"]);

function isHumanAuthored(event) {
  if (event?.isCompactSummary === true) return false;
  return !NON_HUMAN_ORIGINS.has(event?.origin?.kind);
}

const INTERRUPT_MARKERS = new Set(["[Request interrupted by user]", "[Request interrupted by user for tool use]"]);

// Records from before origin existed: the interrupt markers Claude Code
// writes, and another session's message in its <agent-message> envelope.
function isHostEventText(text, event) {
  if (INTERRUPT_MARKERS.has(text)) return true;
  return event?.origin === undefined && hasEnvelopePrefix(text, "agent-message");
}

function normalizeClaudeUserText(text) {
  let trimmed = String(text || "").trim();
  const initialCommand = commandIntent(trimmed);
  if (initialCommand) return initialCommand;
  if (hasEnvelopePrefix(trimmed, "command-message")) return "";

  const injectedTags = [
    "system-reminder",
    "preview-annotation-context",
    "task-notification",
    "local-command-caveat",
    "local-command-stdout",
    "bash-input",
    "bash-stdout",
    "command-name",
    "turn_aborted",
  ];
  for (;;) {
    let stripped = false;
    for (const tag of injectedTags) {
      const remaining = stripLeadingEnvelope(trimmed, tag);
      if (remaining !== null) {
        trimmed = remaining;
        stripped = true;
        break;
      }
    }
    if (!stripped) break;
  }
  if (!trimmed) return "";
  const command = commandIntent(trimmed);
  if (command) return command;
  return hasEnvelopePrefix(trimmed, "command-message") ? "" : trimmed;
}

function commandIntent(text) {
  if (!hasEnvelopePrefix(text, "command-message")) return "";
  const name = envelopeValue(text, "command-name");
  if (!name.startsWith("/")) return "";
  const args = envelopeValue(text, "command-args");
  return `${name} ${args}`.trim();
}

function stripLeadingEnvelope(text, tag) {
  if (!hasEnvelopePrefix(text, tag)) return null;
  const close = `</${tag}>`;
  const end = text.indexOf(close);
  if (end < 0) return null;
  return text.slice(end + close.length).trim();
}

function hasEnvelopePrefix(text, tag) {
  if (!text.startsWith(`<${tag}`)) return false;
  return [">", " ", "\t", "\n", "\r"].includes(text.at(tag.length + 1));
}

function envelopeValue(text, tag) {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = text.indexOf(open);
  if (start < 0) return "";
  const valueStart = start + open.length;
  const end = text.indexOf(close, valueStart);
  return end < 0 ? "" : text.slice(valueStart, end).trim();
}

// extractToolResults pulls every `tool_result` block out of a CC user-
// envelope content array and converts each into an EverMe role=tool
// message. CC encodes tool_result as a content block inside a user
// envelope (not a separate top-level event), so without this step the
// entire tool round-trip is lost.
function extractToolResults(content, timestamp, dropped) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type !== "tool_result") continue;
    const toolCallId = firstToolId(b.tool_use_id, b.toolCallId, b.tool_call_id);
    if (!toolCallId) {
      dropped.results++;
      continue;
    }
    let text;
    if (typeof b.content === "string") {
      text = b.content;
    } else if (Array.isArray(b.content)) {
      // tool_result.content can itself be a list of typed blocks (e.g.
      // [{type:"text", text:...}]) — flatten the text-bearing ones.
      text = b.content
        .map((c) => {
          if (typeof c === "string") return c;
          if (c?.type === "text" && typeof c.text === "string") return c.text;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    } else {
      text = safeJsonStringify(b.content);
    }
    out.push({ role: AGENT_MEMORY_ROLES.TOOL, timestamp, toolCallId, content: text });
  }
  return out;
}

function agentAssistantMessage(content, timestamp, dropped) {
  if (typeof content === "string") {
    return content ? { role: AGENT_MEMORY_ROLES.ASSISTANT, timestamp, content } : null;
  }
  if (!Array.isArray(content)) return null;
  const textParts = [];
  const toolCalls = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") {
      textParts.push(b.text);
    } else if (b.type === "tool_use" || b.type === "toolCall") {
      const id = firstToolId(b.id, b.tool_use_id);
      if (!id) {
        dropped.calls++;
        continue;
      }
      const args = b.input ?? b.arguments ?? {};
      toolCalls.push({
        id,
        type: AGENT_MEMORY_TOOL_CALL_TYPES.FUNCTION,
        name: b.name,
        arguments: typeof args === "string" ? args : safeJsonStringify(args),
      });
    }
  }
  const out = { role: AGENT_MEMORY_ROLES.ASSISTANT, timestamp };
  const text = textParts.join("\n\n");
  if (text) out.content = text;
  if (toolCalls.length) out.toolCalls = toolCalls;
  return text.trim() || toolCalls.length ? out : null;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (typeof b === "string") return b;
      if (b?.type === "text" && typeof b.text === "string") return b.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeTimestamp(ts) {
  if (typeof ts === "number" && Number.isFinite(ts)) {
    return ts > 10_000_000_000 ? Math.trunc(ts) : Math.trunc(ts * 1000);
  }
  const parsed = Date.parse(ts);
  if (Number.isFinite(parsed)) return parsed;
  // No host time: the SDK assigns a fallback once and reuses it on resends.
  return undefined;
}

function flattenAssistant(content) {
  if (typeof content === "string") {
    return { text: content, hasToolCall: false };
  }
  if (!Array.isArray(content)) return { text: "", hasToolCall: false };
  const parts = [];
  let hasToolCall = false;
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "tool_use") {
      hasToolCall = true;
      parts.push(
        `[tool_use ${b.name || "unknown"}] ${safeJsonStringify(b.input)}`,
      );
    } else if (b.type === "tool_result") {
      hasToolCall = true;
      const tr =
        typeof b.content === "string" ? b.content : safeJsonStringify(b.content);
      parts.push(`[tool_result ${b.tool_use_id || ""}] ${tr}`);
    }
  }
  return { text: parts.join("\n\n"), hasToolCall };
}

function safeJsonStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Build a single markdown document from a turn sequence — same shape
 * the @everme/memory-mcp runtime buffer writes, so backend chunkers /
 * classifiers behave identically.
 */
export function buildTranscriptMarkdown(turns, { sessionId, agentId }) {
  const now = new Date().toISOString();
  const lines = [
    "---",
    `everme_runtime_version: 1`,
    `agent_id: ${agentId || "agt_claude_code"}`,
    `session_key: ${sessionId || "claude-code-session"}`,
    `last_flushed_at: ${now}`,
    `turn_count: ${turns.length}`,
    "---",
    "",
    `# Claude Code session ${sessionId || ""}`,
    "",
  ];
  for (const t of turns) {
    lines.push(`## ${t.role} · ${new Date(t.ts).toISOString()}`);
    lines.push("");
    lines.push(t.text);
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n");
}
