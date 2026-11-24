import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { capRunes } from "@everme/agent-sdk";

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
  const diagnostics = new Map();
  const warnRecord = (reason) => diagnostics.set(reason, (diagnostics.get(reason) || 0) + 1);

  for await (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      warnRecord("invalid_json");
      continue;
    }
    const message = mapRecord(record, warnRecord);
    if (!message) continue;
    if (message.role === "user") {
      delta = message.content ? [message] : [];
    } else {
      delta.push(message);
    }
  }

  if (typeof warn === "function") {
    for (const [reason, count] of diagnostics) warn(reason, count);
  }
  return delta;
}

function mapRecord(record, warn) {
  const type = typeof record?.type === "string" ? record.type : "";
  if (type === "tool_call" || type === "toolCall") return mapToolCall(record, warn);
  if (type === "tool_result" || type === "toolResult") return mapToolResult(record, warn);
  if (IGNORED_RECORD_TYPES.has(type)) return null;

  const value = record?.message && typeof record.message === "object" ? record.message : record;
  // Preserve existing compatibility layouts; the native transcript uses record.role.
  const role = pickRole(value?.role) || pickRole(record?.role) || pickRole(record?.type);
  if (!role) {
    warn("unknown_record_type");
    return null;
  }
  const content = value?.content ?? value?.text ?? record?.content ?? record?.text;
  if (role === "user") return { role, content: capText(stripUserEnvelope(plainText(content))) };
  const { text, toolCalls, hasToolCalls } = readContent(content, warn);
  if (!text && !toolCalls.length) return null;
  return {
    role,
    ...(text ? { content: text } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(hasToolCalls && !toolCalls.length ? { turnComplete: false } : {}),
  };
}

function mapToolCall(record, warn) {
  const payload = firstObject(record.tool_call, record.toolCall, record.message, record);
  const name = firstString(payload.name, payload.tool_name, payload.tool, record.tool_name);
  const id = firstString(payload.id, payload.call_id, payload.tool_call_id, record.tool_call_id);
  const args = payload.arguments ?? payload.args ?? payload.input ?? payload.tool_input
    ?? record.tool_input;
  const call = checkedCall(id, name, args, warn);
  if (!call) return null;
  return {
    role: "assistant",
    toolCalls: [call],
  };
}

function mapToolResult(record, warn) {
  const payload = firstObject(record.tool_result, record.toolResult, record);
  const toolCallId = firstString(
    payload.tool_call_id,
    payload.call_id,
    payload.toolCallId,
    record.tool_call_id,
  );
  if (!toolCallId.trim()) {
    warn("invalid_tool_id");
    return null;
  }
  const content = record.message?.content ?? payload.content ?? payload.output ?? payload.result;
  if (typeof content !== "string" && !Array.isArray(content)) {
    warn("invalid_tool_output");
    return null;
  }
  return { role: "tool", toolCallId, content: plainText(content) };
}

function pickRole(candidate) {
  return candidate === "user" || candidate === "assistant" ? candidate : "";
}

function readContent(content, warn) {
  if (typeof content === "string") return { text: capText(content), toolCalls: [] };
  if (!Array.isArray(content)) return { text: "", toolCalls: [] };
  const parts = [];
  const toolCalls = [];
  let hasToolCalls = false;
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
    } else if (typeof part?.text === "string" && (!part.type || part.type === "text")) {
      parts.push(part.text);
    } else if (part?.type === "tool_use" || part?.type === "toolCall" || part?.type === "tool_call") {
      hasToolCalls = true;
      const call = checkedCall(firstString(part.id, part.call_id, part.tool_call_id),
        firstString(part.name, part.tool_name), part.input ?? part.arguments ?? part.args, warn);
      if (call) toolCalls.push(call);
    }
  }
  return { text: capText(parts.filter(Boolean).join("\n")), toolCalls, hasToolCalls };
}

function plainText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => typeof part === "string" ? part
    : typeof part?.text === "string" && (!part.type || part.type === "text") ? part.text : "")
    .filter(Boolean).join("\n");
}

function stripUserEnvelope(text) {
  const envelope = text.trim().match(/^(?:<timestamp>[^<]*<\/timestamp>\s*)?<user_query>\s*\n?([\s\S]*)\n?\s*<\/user_query>$/);
  return envelope ? envelope[1] : text;
}

function checkedCall(id, name, input, warn) {
  if (!id.trim()) { warn("invalid_tool_id"); return null; }
  if (!name.trim()) { warn("invalid_tool_name"); return null; }
  const args = argumentText(input);
  if (args === null) { warn("invalid_tool_arguments"); return null; }
  return { id, type: "function", name, arguments: args };
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
  try {
    if (typeof value === "string") {
      JSON.parse(value);
      return value;
    }
    return value && typeof value === "object" ? JSON.stringify(value) : null;
  } catch {
    return null;
  }
}

function capText(value) {
  return capRunes(String(value || "").trim());
}
