import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { capRunes } from "@everme/agent-sdk";

export async function readLastTurn(transcriptPath) {
  if (!transcriptPath) return [];
  const lines = createInterface({
    input: createReadStream(transcriptPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let delta = [];
  let foundUser = false;

  for await (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "response_item" || !event.payload) continue;
    const message = mapPayload(event.payload, event.timestamp);
    if (!message) continue;

    if (message.role === "user") {
      delta = [message];
      foundUser = true;
    } else if (foundUser) {
      delta.push(message);
    }
  }
  return foundUser ? delta : [];
}

function mapPayload(payload, timestampValue) {
  const timestamp = normalizeTimestamp(timestampValue);
  if (payload.type === "message") {
    if (payload.role !== "user" && payload.role !== "assistant") return null;
    const content = contentText(payload.content);
    if (!content) return null;
    return { role: payload.role, ...stamp(timestamp), content };
  }
  if (payload.type === "function_call") {
    return {
      role: "assistant",
      ...stamp(timestamp),
      toolCalls: [{
        id: payload.call_id || `codex_tool_${timestamp ?? "untimed"}`,
        type: "function",
        name: payload.name || "unknown",
        arguments: argumentText(payload.arguments),
      }],
    };
  }
  if (payload.type === "function_call_output" && payload.call_id) {
    return {
      role: "tool",
      ...stamp(timestamp),
      toolCallId: payload.call_id,
      content: capText(payload.output || "tool result"),
    };
  }
  return null;
}

function stamp(timestamp) {
  return timestamp === undefined ? {} : { timestamp };
}

function contentText(content) {
  if (typeof content === "string") return capText(content);
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
    } else if (["input_text", "output_text", "text"].includes(item?.type) && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return capText(parts.join("\n"));
}

function argumentText(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function normalizeTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.trunc(value) : Math.trunc(value * 1000);
  }
  const parsed = Date.parse(value);
  // undefined — never 0: 0 is a finite epoch (1970) that the SDK would ship
  // as-is, while a missing timestamp makes the SDK stamp Date.now() instead,
  // keeping the epoch-ms wire contract honest.
  return Number.isFinite(parsed) ? parsed : undefined;
}

// SDK capRunes keeps head AND tail (0.7 head ratio) so the end of a long
// tool output — exit status, root-cause line — survives truncation.
function capText(value) {
  return capRunes(String(value || "").trim());
}
