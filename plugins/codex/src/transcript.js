import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { capRunes, humanTextFromWrappers } from "@everme/agent-sdk";

const INJECTED_CONTEXT_TAGS = [
  "app-context",
  "apps_instructions",
  "codex_internal_context",
  "environment_context",
  "in-app-browser-context",
  "multi_agent_mode",
  "permissions",
  "plugins_instructions",
  "recommended_plugins",
  "skills_instructions",
];

const SYNTHETIC_USER_TAGS = [
  "bash-input",
  "bash-stdout",
  "command-name",
  "local-command-stdout",
  "task-notification",
  "turn_aborted",
];

const KNOWN_EVENT_MESSAGES = new Set([
  "agent_message", "agent_reasoning", "context_compacted", "item_completed",
  "mcp_tool_call_begin", "mcp_tool_call_end", "patch_apply_begin", "patch_apply_end",
  "reasoning", "task_complete", "task_started", "sub_agent_activity", "thread_goal_updated",
  "thread_rolled_back", "thread_settings_applied", "token_count", "turn_aborted",
  "turn_complete", "user_message", "web_search_begin", "web_search_end",
]);

export function readLastTurn(transcriptPath, options = {}) {
  return readTranscript(transcriptPath, { ...options, lastTurnOnly: true });
}

export function readCanonicalTranscript(transcriptPath, options = {}) {
  return readTranscript(transcriptPath, { ...options, lastTurnOnly: false });
}

async function readTranscript(transcriptPath, { lastTurnOnly, diagnostic = () => {} }) {
  if (!transcriptPath) return [];
  const legacyUsersBySegment = await collectLegacyUserMessages(transcriptPath);
  const fallbackTimestampBase = await transcriptFallbackTimestampBase(transcriptPath);
  const lines = createInterface({
    input: createReadStream(transcriptPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  const state = newParseState(legacyUsersBySegment);
  let messages = [];
  let lineNumber = 0;

  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    lineNumber += 1;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      countDiagnostic(state, "malformed_json");
      continue;
    }
    const payload = event?.payload;
    if (event?.type === "session_meta") {
      observeSessionMeta(state, payload);
      if (lastTurnOnly) messages = [];
      continue;
    }
    if (skipsInheritedSubagentEvent(state, event)) {
      countDiagnostic(state, "inherited_context");
      continue;
    }
    observeTurn(state, payload);
    if (event?.type === "turn_context") {
      continue;
    }
    if (["task_complete", "turn_complete"].includes(event?.type) || (event?.type === "event_msg"
      && ["task_complete", "turn_complete"].includes(payload?.type))) {
      if (event.type !== "event_msg" && typeof event.turn_id === "string" && event.turn_id) {
        observeTurn(state, event);
      }
      const last = messages.at(-1);
      if (last && last === state.lastAssistant && last.turnComplete !== false
        && (last.turnId || "") === state.turnId) {
        setBoundaryMetadata(last, "turnComplete", true);
      }
      continue;
    }
    if (event?.type === "event_msg") {
      if (!KNOWN_EVENT_MESSAGES.has(payload?.type)) countDiagnostic(state, "unknown_event_message");
      continue;
    }
    if (event?.type !== "response_item" || !payload) {
      if (!["compacted"].includes(event?.type)) countDiagnostic(state, "unknown_event");
      continue;
    }

    const message = mapPayload(
      payload,
      event.timestamp,
      fallbackTimestampBase + lineNumber,
      lineNumber,
      state,
    );
    if (!message) continue;
    if (state.turnId) setBoundaryMetadata(message, "turnId", state.turnId);
    if (lastTurnOnly && message.role === "user") {
      messages = [message];
    } else {
      messages.push(message);
    }
  }
  if (state.isSubagent && !messages.some((message) => message.role === "user")) {
    countDiagnostic(state, "subagent_without_user");
    messages = [];
  }
  diagnoseToolPairs(messages, state);
  if (Object.keys(state.diagnostics).length) {
    const counts = Object.entries(state.diagnostics).map(([reason, count]) => `${reason}=${count}`).join(" ");
    diagnostic(`[everme] codex parse lines=${lineNumber} messages=${messages.length} ${counts}`.slice(0, 1024));
  }
  return messages;
}

function countDiagnostic(state, reason) {
  state.diagnostics[reason] = (state.diagnostics[reason] || 0) + 1;
}

function sourceCallId(payload) {
  return typeof payload?.call_id === "string" && payload.call_id.trim() ? payload.call_id : "";
}

function diagnoseToolPairs(messages, state) {
  const seen = new Set();
  const pending = new Map();
  for (const message of messages) {
    for (const call of message.toolCalls || []) {
      if (seen.has(call.id)) countDiagnostic(state, "duplicate_call_id");
      seen.add(call.id);
      pending.set(call.id, (pending.get(call.id) || 0) + 1);
    }
    if (message.role !== "tool") continue;
    const count = pending.get(message.toolCallId) || 0;
    if (!count) countDiagnostic(state, "orphan_result");
    else if (count === 1) pending.delete(message.toolCallId);
    else pending.set(message.toolCallId, count - 1);
  }
  for (const count of pending.values()) {
    state.diagnostics.missing_result = (state.diagnostics.missing_result || 0) + count;
  }
}

function setBoundaryMetadata(message, key, value) {
  Object.defineProperty(message, key, { value, writable: true, configurable: true });
  return message;
}

async function collectLegacyUserMessages(transcriptPath) {
  const usersBySegment = [];
  const lines = createInterface({
    input: createReadStream(transcriptPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  const state = newParseState([]);
  for await (const rawLine of lines) {
    let event;
    try {
      event = JSON.parse(rawLine);
    } catch {
      continue;
    }
    const payload = event?.payload;
    if (event?.type === "session_meta") {
      observeSessionMeta(state, payload);
      continue;
    }
    if (skipsInheritedSubagentEvent(state, event) || state.isSubagent
      || event?.type !== "event_msg" || payload?.type !== "user_message"
      || typeof payload.message !== "string") continue;
    const text = payload.message.trim();
    if (!text) continue;
    if (!usersBySegment[state.segmentIndex]) usersBySegment[state.segmentIndex] = new Map();
    const users = usersBySegment[state.segmentIndex];
    users.set(text, (users.get(text) || 0) + 1);
  }
  return usersBySegment;
}

function observeTurn(state, payload) {
  const turnId = payload?.turn_id || payload?.internal_chat_message_metadata_passthrough?.turn_id;
  if (typeof turnId !== "string" || !turnId) return;
  state.turnId = turnId;
}

function newParseState(legacyUsersBySegment) {
  return {
    historyMode: "",
    isSubagent: false,
    segmentIndex: 0,
    seenSessionMeta: false,
    outerSessionIsSubagent: false,
    hasSubagentHistoryStart: false,
    subagentHistoryStart: 0,
    legacyUsersBySegment,
    legacyUserMessages: new Map(legacyUsersBySegment[0] || []),
    diagnostics: {},
    turnId: "",
    lastAssistant: null,
  };
}

function observeSessionMeta(state, payload) {
  // Root rollouts can contain multiple sections. Child rollouts instead embed
  // forked root metadata, so their outer subagent identity remains authoritative.
  const firstSessionMeta = !state.seenSessionMeta;
  if (!firstSessionMeta) state.segmentIndex += 1;
  else state.seenSessionMeta = true;
  if (firstSessionMeta) state.outerSessionIsSubagent = sessionMetaIsSubagent(payload);
  if (firstSessionMeta || !state.outerSessionIsSubagent) {
    state.historyMode = typeof payload?.history_mode === "string" ? payload.history_mode : "";
    state.isSubagent = sessionMetaIsSubagent(payload);
    state.hasSubagentHistoryStart = Number.isFinite(payload?.subagent_history_start_ordinal);
    state.subagentHistoryStart = state.hasSubagentHistoryStart
      ? Math.trunc(payload.subagent_history_start_ordinal)
      : 0;
  } else {
    state.isSubagent = true;
  }
  state.legacyUserMessages = new Map(state.legacyUsersBySegment[state.segmentIndex] || []);
  state.turnId = "";
  state.lastAssistant = null;
}

function skipsInheritedSubagentEvent(state, event) {
  return state.isSubagent && state.hasSubagentHistoryStart
    && Number.isFinite(event?.ordinal)
    && Math.trunc(event.ordinal) < state.subagentHistoryStart;
}

function sessionMetaIsSubagent(payload) {
  if (payload && payload.thread_source !== undefined && payload.thread_source !== null) {
    return String(payload.thread_source).trim() === "subagent";
  }
  return Boolean(payload?.parent_thread_id);
}

function mapPayload(payload, timestampValue, fallbackTimestamp, lineNumber, state) {
  const timestamp = normalizeTimestamp(timestampValue, fallbackTimestamp);
  if (payload.type === "message") {
    if (["developer", "system"].includes(payload.role)) {
      countDiagnostic(state, "system_message");
      return null;
    }
    const rawText = contentText(payload.content);
    if (!rawText) {
      countDiagnostic(state, "empty_or_nontext_message");
      return null;
    }
    if (payload.role === "user") {
      // Subagent user records are inherited parent context or an agent-authored
      // task, not a human utterance.
      if (state.isSubagent) {
        countDiagnostic(state, "subagent_user");
        return null;
      }
      const normalized = normalizeUserMessage(state, rawText);
      if (!normalized) {
        countDiagnostic(state, "injected_user");
        return null;
      }
      const content = humanRequestText(normalized);
      // Earlier releases uploaded this record as a user turn; it keeps the
      // turn as an empty placeholder so checkpoints and the gate's turn
      // watermark line up across the upgrade.
      if (!content) {
        countDiagnostic(state, "host_event_user");
        return { role: "user", ...stamp(timestamp), content: "", placeholder: true };
      }
      if (content !== rawText) countDiagnostic(state, "stripped_user_wrapper");
      return { role: "user", ...stamp(timestamp), content: capText(content) };
    }
    if (payload.role !== "assistant") {
      countDiagnostic(state, "unknown_role");
      return null;
    }
    if (legacyToolEnvelope(rawText)) {
      countDiagnostic(state, "dropped_legacy_tool_without_id");
      return null;
    }
    const message = { role: "assistant", ...stamp(timestamp), content: capText(rawText) };
    if (typeof payload.phase === "string" && payload.phase) {
      setBoundaryMetadata(message, "turnComplete", payload.phase === "final_answer");
    }
    state.lastAssistant = message;
    return message;
  }
  if (payload.type === "function_call" || payload.type === "custom_tool_call") {
    const custom = payload.type === "custom_tool_call";
    const callId = sourceCallId(payload);
    if (!callId) {
      countDiagnostic(state, "dropped_missing_call_id");
      return null;
    }
    return {
      role: "assistant",
      ...stamp(timestamp),
      toolCalls: [{
        id: callId,
        type: "function",
        name: payload.name || "unknown",
        arguments: redactText(custom ? customToolArguments(payload.input) : argumentText(payload.arguments)),
        // Source-local provenance for the shared write layer's EverMe filter;
        // convertAgentMessage rebuilds the wire shape and never forwards it.
        // Only present when the host recorded one, so golden shapes are unchanged.
        ...(payload.namespace ? { namespace: payload.namespace } : {}),
      }],
    };
  }
  if (["function_call_output", "custom_tool_call_output"].includes(payload.type)) {
    const toolCallId = sourceCallId(payload);
    if (!toolCallId) {
      countDiagnostic(state, "dropped_missing_result_id");
      return null;
    }
    if (!Object.hasOwn(payload, "output")) countDiagnostic(state, "missing_output_field");
    return {
      role: "tool",
      ...stamp(timestamp),
      toolCallId,
      content: redactText(outputText(payload.output)),
    };
  }
  if (payload.type === "web_search_call") {
    return setBoundaryMetadata({
      role: "assistant",
      ...stamp(timestamp),
      // This source record has no paired result; preserve it without inventing one.
      content: capText(JSON.stringify(payload)),
    }, "turnComplete", false);
  }
  if (payload.type === "agent_message") {
    countDiagnostic(state, "internal_agent_message");
    return null;
  }
  if (payload.type === "reasoning") {
    countDiagnostic(state, "internal_reasoning");
    return null;
  }
  countDiagnostic(state, "unknown_payload");
  return null;
}

// The Codex desktop app wraps what the person typed in its own scaffolding
// and unwraps it again for display. Each rule mirrors a shape that app or the
// CLI writes, and only removes text the app itself generated: attachment
// lists, annotation quotes and ambient UI state. Selected text, pasted files
// and anything else the person brought along stay.
const WRAPPED_REQUEST_HEADERS = ["# Files mentioned by the user:", "# Response annotations:"];
const REQUEST_MARKER = /## My request(?: for Codex)?:/g;
const PAGE_COMMENT_OPEN = "<page-comment-context>\n";
const PAGE_COMMENT_CLOSE = "\n</page-comment-context>\n";
const BROWSER_STATE = /<in-app-browser-context source="ambient-ui-state">[\s\S]*?<\/in-app-browser-context>/g;
// codex-rs AdditionalContextUserFragment renders app-supplied context as
// "<external_" + key + ">" + value + "</external_" + key + ">"; the apps page
// state is the one the desktop app sends with every message.
const APPS_PAGE_STATE = /<external_codex_apps_open_page>[\s\S]*?<\/external_codex_apps_open_page>/g;
const QUESTION_REPLY_OPEN = "<send_user_message_question_reply>";
const QUESTION_REPLY_CLOSE = "</send_user_message_question_reply>";
const AUTO_REVIEW_PROMPT = "The following is the Codex agent history whose request action you are assessing";

function humanRequestText(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("<heartbeat>") && trimmed.endsWith("</heartbeat>")) return "";
  if (trimmed.startsWith(AUTO_REVIEW_PROMPT)) return "";
  const answers = questionReplyAnswers(trimmed);
  if (answers !== null) return answers;
  return visibleRequest(humanTextFromWrappers(text.replace(BROWSER_STATE, "").replace(APPS_PAGE_STATE, ""))).trim();
}

function visibleRequest(text) {
  if (text.startsWith(PAGE_COMMENT_OPEN)) {
    const close = text.indexOf(PAGE_COMMENT_CLOSE, PAGE_COMMENT_OPEN.length);
    const rest = close < 0 ? "" : text.slice(close + PAGE_COMMENT_CLOSE.length);
    if (rest.startsWith("## My request:\n")) return rest.slice("## My request:\n".length);
    return text;
  }
  const header = WRAPPED_REQUEST_HEADERS.find((candidate) => text.trimStart().startsWith(candidate));
  if (!header) return text;
  const parts = text.split(REQUEST_MARKER);
  if (parts.length < 2) return text;
  const scaffolding = parts.slice(0, -1).join("").trimStart().slice(header.length);
  // Another top-level section (selected text, pasted files) is material the
  // person brought along; leave the whole message as it is.
  if (/^# /m.test(scaffolding)) return text;
  return parts[parts.length - 1];
}

function questionReplyAnswers(text) {
  if (!text.startsWith(QUESTION_REPLY_OPEN) || !text.endsWith(QUESTION_REPLY_CLOSE)) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(QUESTION_REPLY_OPEN.length, -QUESTION_REPLY_CLOSE.length));
  } catch {
    return null;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (!items.length || !items.every((item) => typeof item?.answer === "string")) return null;
  return items.map((item) => item.answer.trim()).filter(Boolean).join("\n");
}

function normalizeUserMessage(state, text) {
  if (state.historyMode !== "paginated") {
    const remaining = state.legacyUserMessages.get(text) || 0;
    if (remaining === 0) return "";
    state.legacyUserMessages.set(text, remaining - 1);
    return text;
  }
  return normalizePaginatedUserText(text);
}

function normalizePaginatedUserText(text) {
  let trimmed = text.trim();
  const tags = [...INJECTED_CONTEXT_TAGS, ...SYNTHETIC_USER_TAGS, "command-args", "command-message"];
  while (trimmed) {
    const objective = goalObjective(trimmed);
    if (objective) return objective;
    const command = commandIntent(trimmed);
    if (command) return command;

    const agentsRemainder = stripLeadingAgentsInstructions(trimmed);
    if (agentsRemainder !== null) {
      trimmed = agentsRemainder;
      continue;
    }

    let stripped = false;
    for (const tag of tags) {
      const remainder = stripLeadingEnvelope(trimmed, tag);
      if (remainder !== null) {
        trimmed = remainder;
        stripped = true;
        break;
      }
    }
    if (!stripped) break;
  }
  return !trimmed || hasEnvelopePrefix(trimmed, "command-message") ? "" : trimmed;
}

function commandIntent(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("<command-message>")) return "";
  const name = envelopeValue(trimmed, "command-name");
  if (!name?.startsWith("/")) return "";
  const args = envelopeValue(trimmed, "command-args");
  return `${name} ${args}`.trim();
}

function stripLeadingEnvelope(text, tag) {
  if (!hasEnvelopePrefix(text, tag)) return null;
  const openEnd = text.indexOf(">");
  if (openEnd < 0) return null;
  const close = `</${tag}>`;
  const closeStart = text.indexOf(close, openEnd + 1);
  if (closeStart < 0) return null;
  return text.slice(closeStart + close.length).trim();
}

function hasEnvelopePrefix(text, tag) {
  if (!text.startsWith(`<${tag}`)) return false;
  return [">", " ", "\t", "\n", "\r"].includes(text.at(tag.length + 1));
}

function stripLeadingAgentsInstructions(text) {
  const lineEnd = text.indexOf("\n");
  if (lineEnd < 0) return null;
  const title = text.slice(0, lineEnd).replace(/\r$/, "");
  const scopedTitlePrefix = "# AGENTS.md instructions for ";
  const isAgentsInstructions = title === "# AGENTS.md instructions"
    || (title.startsWith(scopedTitlePrefix) && title.slice(scopedTitlePrefix.length).trim().length > 0);
  if (!isAgentsInstructions || !text.includes("<INSTRUCTIONS>")) return null;
  const close = "</INSTRUCTIONS>";
  const closeStart = text.indexOf(close);
  return closeStart < 0 ? "" : text.slice(closeStart + close.length).trim();
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

function goalObjective(text) {
  const prefix = '<codex_internal_context source="goal">';
  if (!text.startsWith(prefix)) return "";
  const close = "</codex_internal_context>";
  const end = text.indexOf(close, prefix.length);
  if (end < 0) return "";
  const body = text.slice(prefix.length, end);
  if (!body.includes("The objective below is user-provided data.")) return "";
  const objective = envelopeValue(body, "objective");
  if (!objective) return "";
  const suffix = normalizePaginatedUserText(text.slice(end + close.length));
  return suffix ? `${objective}\n\n${suffix}` : objective;
}

function legacyToolEnvelope(text) {
  const trimmed = text.trim();
  const callMatch = trimmed.match(/^\[external_agent_tool_call:\s*([^\]]+)\]\s*([\s\S]*?)\s*\[\/external_agent_tool_call\]$/);
  if (callMatch) {
    return { kind: "call", name: callMatch[1].trim() || "unknown", body: callMatch[2].trim() };
  }
  const resultMatch = trimmed.match(/^\[external_agent_tool_result\]\s*([\s\S]*?)\s*\[\/external_agent_tool_result\]$/);
  if (resultMatch) return { kind: "result", body: resultMatch[1].trim() };
  return null;
}

function stamp(timestamp) {
  return timestamp === undefined ? {} : { timestamp };
}

function contentText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
    } else if (["input_text", "output_text", "text"].includes(item?.type) && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts.join("\n").trim();
}

function outputText(value) {
  return typeof value === "string" ? value.trim() : contentText(value);
}

function argumentText(value) {
  if (typeof value === "string") {
    if (!value.trim()) return "{}";
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify({ input: value });
    }
  }
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function customToolArguments(value) {
  if (value == null || value === "") return "{}";
  try {
    return JSON.stringify({ input: value });
  } catch {
    return "{}";
  }
}

function normalizeTimestamp(value, fallbackTimestamp) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.trunc(value) : Math.trunc(value * 1000);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallbackTimestamp;
}

async function transcriptFallbackTimestampBase(transcriptPath) {
  try {
    return Math.trunc((await stat(transcriptPath)).mtimeMs);
  } catch {
    return 0;
  }
}

function capText(value) {
  return capRunes(redactText(String(value || "").trim()));
}

function redactText(value) {
  return String(value || "")
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[redacted]")
    .replace(/evt_[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/emk_[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/ghp_[A-Za-z0-9]{20,}/g, "[redacted]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[redacted]")
    .replace(/bearer\s+[A-Za-z0-9._=-]{10,}/gi, "[redacted]")
    .replace(/X-Amz-Signature=[A-Za-z0-9%]+/g, "[redacted]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted]");
}
