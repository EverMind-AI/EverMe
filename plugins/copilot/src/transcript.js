/**
 * Copilot CLI session event reader.
 *
 * The agentStop hook payload carries `transcriptPath`, which points at
 *
 *   <COPILOT_HOME>/session-state/<sessionId>/events.jsonl
 *
 * Each line is one session event `{id, timestamp, parentId, type, data,
 * agentId?}` (schemas/session-events.schema.json in @github/copilot). Three
 * types carry the conversation:
 *
 *   - `user.message`: `data.content` is the text as the user typed it;
 *     `data.transformedContent` is the model-facing copy with host wrapping,
 *     so it is never read here.
 *   - `assistant.message`: `data.content` plus `data.toolRequests[]`
 *     `{toolCallId, name, arguments}`; reasoning fields are not uploaded.
 *   - `tool.execution_complete`: `data.toolCallId`, `data.result.content`
 *     (the text the model saw) or `data.error.message`.
 *
 * Sub-agent events carry `agentId` or `data.parentToolCallId` and belong to
 * the sub-agent run, so the parent session skips them. Autopilot continuation
 * prompts (`isAutopilotContinuation`) and prompts injected by skills or other
 * agents (`data.source` set) are not something the user typed. A
 * `session.snapshot_rewind` event removes earlier events from the history, so
 * those are dropped before any message is built.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { AGENT_MEMORY_ROLES, filterInvalidTools } from "@everme/agent-sdk";

const READ_RETRIES = 5;
const RETRY_DELAY_MS = 100;

const CONTENT_TYPES = new Set(["user.message", "assistant.message", "tool.execution_complete"]);
const INJECTED_TAGS = ["everme_recall", "everme_profile", "everos_recall", "everos_profile"];

export async function readEvents(path) {
  if (!path || !existsSync(path)) return [];
  let lastError;
  for (let attempt = 0; attempt < READ_RETRIES; attempt += 1) {
    try {
      const raw = await readFile(path, "utf8");
      return raw.split("\n").filter((line) => line.trim().length > 0);
    } catch (error) {
      lastError = error;
      if (error?.code !== "EBUSY" && error?.code !== "EAGAIN") break;
      await sleep(RETRY_DELAY_MS);
    }
  }
  if (lastError && lastError.code !== "ENOENT") throw lastError;
  return [];
}

/**
 * Main-agent conversation events in file order, with rewound events removed.
 * A torn trailing line (the host appends while the hook reads) is skipped.
 */
export function effectiveEvents(lines) {
  const events = [];
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== "object" || event.ephemeral === true) continue;
    events.push(event);
  }
  const removed = new Set();
  for (const event of events) {
    if (event.type !== "session.snapshot_rewind") continue;
    const ids = event.data?.eventIds;
    if (Array.isArray(ids) && ids.length) {
      for (const id of ids) removed.add(id);
      continue;
    }
    const start = events.findIndex((candidate) => candidate.id === event.data?.upToEventId);
    if (start < 0) continue;
    const end = events.indexOf(event);
    for (let index = start; index < end; index += 1) removed.add(events[index].id);
  }
  return events.filter((event) => (
    CONTENT_TYPES.has(event.type)
    && !removed.has(event.id)
    && !event.agentId
    && !event.data?.parentToolCallId
  ));
}

/**
 * Turns events into EverMe agent-memory messages. With `sourceIdentity`, each
 * message carries the id of the event it came from, which the native
 * checkpoint uses as its key.
 */
export function extractMessages(lines, { sourceIdentity = false } = {}) {
  const messages = [];
  const dropped = { calls: 0, results: 0 };
  const requested = new Set();
  for (const event of effectiveEvents(lines)) {
    const data = event.data && typeof event.data === "object" ? event.data : {};
    const timestamp = normalizeTimestamp(event.timestamp);
    const identify = (message) => sourceIdentity ? { ...message, sourceRecordId: event.id } : message;

    if (event.type === "user.message") {
      if (data.isAutopilotContinuation === true || data.source) continue;
      const text = stripInjectedBlocks(typeof data.content === "string" ? data.content : "");
      if (text) messages.push(identify({ role: AGENT_MEMORY_ROLES.USER, timestamp, content: text }));
      continue;
    }
    if (event.type === "assistant.message") {
      const toolCalls = [];
      for (const request of Array.isArray(data.toolRequests) ? data.toolRequests : []) {
        if (!validNativeID(request?.toolCallId)) {
          dropped.calls += 1;
          continue;
        }
        requested.add(request.toolCallId);
        toolCalls.push({
          id: request.toolCallId,
          name: typeof request.name === "string" ? request.name : "",
          arguments: safeJsonStringify(request.arguments ?? {}),
        });
      }
      const text = typeof data.content === "string" ? data.content.trim() : "";
      if (!text && !toolCalls.length) continue;
      const message = { role: AGENT_MEMORY_ROLES.ASSISTANT, timestamp, content: text };
      if (toolCalls.length) message.toolCalls = toolCalls;
      messages.push(identify(message));
      continue;
    }
    if (event.type === "tool.execution_complete") {
      // A result whose call was never requested in this history (a rewound
      // or sub-agent call, a user-run command) has nothing to pair with.
      if (!validNativeID(data.toolCallId) || !requested.has(data.toolCallId)) {
        dropped.results += 1;
        continue;
      }
      messages.push(identify({
        role: AGENT_MEMORY_ROLES.TOOL,
        timestamp,
        toolCallId: data.toolCallId,
        content: toolResultText(data),
      }));
    }
  }
  markTurnEnds(messages);
  if (dropped.calls || dropped.results) {
    console.warn(`[everme] copilot unpaired_tool calls=${dropped.calls} results=${dropped.results}`);
  }
  return filterInvalidTools(messages, { platform: "copilot-cli" });
}

/** Stable per-turn key: the id of the last main-agent conversation event. */
export function resolveTurnKey(lines) {
  const events = effectiveEvents(lines);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (typeof events[index].id === "string" && events[index].id) return events[index].id;
  }
  return "";
}

/** Messages from the last user message onwards — one conversational turn. */
export function lastTurn(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === AGENT_MEMORY_ROLES.USER) return messages.slice(index);
  }
  return messages;
}

// The event log has no per-turn end marker (`assistant.turn_end` closes one
// model call, not the user's turn), so the final reply of a user turn is the
// last assistant message before the next user message that carries text and
// no tool request. A turn still in progress at the end of the file is left
// unmarked unless its last message is such a reply.
function markTurnEnds(messages) {
  let candidate = -1;
  const close = () => {
    if (candidate >= 0) messages[candidate].turnComplete = true;
    candidate = -1;
  };
  for (const [index, message] of messages.entries()) {
    if (message.role === AGENT_MEMORY_ROLES.USER) {
      close();
      continue;
    }
    if (message.role === AGENT_MEMORY_ROLES.ASSISTANT) {
      candidate = message.content && !message.toolCalls?.length ? index : -1;
      continue;
    }
    candidate = -1;
  }
  close();
}

function toolResultText(data) {
  if (data.success === false) {
    const error = data.error?.message;
    if (typeof error === "string") return error;
  }
  const content = data.result?.content;
  if (typeof content === "string") return content;
  if (content == null) return "";
  return safeJsonStringify(content);
}

function validNativeID(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// Only leading envelopes are injection candidates; inline tags can be user prose.
function stripInjectedBlocks(text) {
  let out = String(text || "").trim();
  for (;;) {
    const tag = INJECTED_TAGS.find((candidate) => out.startsWith(`<${candidate}>`));
    if (!tag) break;
    const close = `</${tag}>`;
    const end = out.indexOf(close);
    out = end < 0 ? "" : out.slice(end + close.length).trim();
  }
  return out;
}

function normalizeTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  // No host time: the SDK assigns a fallback once and reuses it on resends.
  return undefined;
}

function safeJsonStringify(value) {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
