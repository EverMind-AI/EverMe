import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { capRunes } from "@everme/agent-sdk";

// Record types Cursor writes that intentionally carry nothing we save.
// Anything else without a recognisable role or tool payload is reported
// through `warn` so the next transcript-schema drift is visible instead
// of silently dropped (the failure mode that hid the 3.16 rewrite).
const IGNORED_RECORD_TYPES = new Set([
  "reasoning",
  "thinking",
  "system",
  "turn_started",
  "turn_ended",
]);

export async function readLastTurn(transcriptPath, { warn } = {}) {
  if (!transcriptPath) return [];
  const lines = createInterface({
    input: createReadStream(transcriptPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let delta = [];
  let foundUser = false;
  let lineNo = 0;
  const unknownTypes = new Set();

  for await (const line of lines) {
    lineNo += 1;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const message = mapRecord(record, lineNo, unknownTypes);
    if (!message) continue;
    if (message.role === "user") {
      delta = [message];
      foundUser = true;
    } else if (foundUser) {
      delta.push(message);
    }
  }

  if (typeof warn === "function") {
    for (const type of unknownTypes) warn(type);
  }
  return foundUser ? delta : [];
}

function mapRecord(record, lineNo, unknownTypes) {
  const type = typeof record?.type === "string" ? record.type : "";
  if (type === "tool_call" || type === "toolCall") return mapToolCall(record, lineNo);
  if (type === "tool_result" || type === "toolResult") return mapToolResult(record);

  const value = record?.message && typeof record.message === "object" ? record.message : record;
  // Cursor has written three role layouts so far: nested message.role,
  // role on the record itself, and role carried as the record type. Try
  // all of them so an older or future layout still parses.
  const role = pickRole(value?.role) || pickRole(record?.role) || pickRole(record?.type);
  if (!role) {
    if (type && !IGNORED_RECORD_TYPES.has(type)) unknownTypes.add(type);
    return null;
  }
  const { text, toolCalls } = readContent(value?.content ?? value?.text ?? record?.content ?? record?.text, lineNo);
  if (role === "user") return text ? { role, content: text } : null;
  if (!text && !toolCalls.length) return null;
  return {
    role,
    ...(text ? { content: text } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
  };
}

// No verified full sample of the 3.16 event stream exists yet, so field
// names are matched leniently across the layouts Cursor and its CLI have
// been reported to write. A wrong guess degrades to a synthesized id or a
// dropped optional field, never a dropped call.
function mapToolCall(record, lineNo) {
  const payload = firstObject(record.tool_call, record.toolCall, record.message, record);
  const name = firstString(payload.name, payload.tool_name, payload.tool, record.tool_name);
  const id = firstString(payload.id, payload.call_id, payload.tool_call_id, record.tool_call_id)
    || `cursor_tool_${lineNo}`;
  const args = payload.arguments ?? payload.args ?? payload.input ?? payload.tool_input
    ?? record.tool_input ?? {};
  return {
    role: "assistant",
    toolCalls: [{ id, type: "function", name: name || "unknown", arguments: argumentText(args) }],
  };
}

function mapToolResult(record) {
  const payload = firstObject(record.tool_result, record.toolResult, record);
  const toolCallId = firstString(
    payload.tool_call_id,
    payload.call_id,
    payload.toolCallId,
    record.tool_call_id,
  );
  // A result that names no call cannot be paired downstream (the SDK
  // requires toolCallId on tool roles) — drop it rather than guess.
  if (!toolCallId) return null;
  const { text } = readContent(
    record.message?.content ?? payload.content ?? payload.output ?? payload.result,
    0,
  );
  return { role: "tool", toolCallId, content: text || "tool result" };
}

function pickRole(candidate) {
  return candidate === "user" || candidate === "assistant" ? candidate : "";
}

function readContent(content, lineNo) {
  if (typeof content === "string") return { text: capText(content), toolCalls: [] };
  if (!Array.isArray(content)) return { text: "", toolCalls: [] };
  const parts = [];
  const toolCalls = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
    } else if (typeof part?.text === "string" && (!part.type || part.type === "text")) {
      parts.push(part.text);
    } else if (part?.type === "tool_use" || part?.type === "toolCall" || part?.type === "tool_call") {
      const id = firstString(part.id, part.call_id, part.tool_call_id)
        || `cursor_tool_${lineNo}_${toolCalls.length}`;
      toolCalls.push({
        id,
        type: "function",
        name: firstString(part.name, part.tool_name) || "unknown",
        arguments: argumentText(part.input ?? part.arguments ?? part.args ?? {}),
      });
    }
  }
  return { text: capText(parts.filter(Boolean).join("\n")), toolCalls };
}

function firstObject(...candidates) {
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return candidate;
  }
  return {};
}

function firstString(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return "";
}

function argumentText(value) {
  if (typeof value === "string") return capText(value);
  try {
    return capText(JSON.stringify(value ?? {}));
  } catch {
    return "{}";
  }
}

function capText(value) {
  return capRunes(String(value || "").trim());
}
