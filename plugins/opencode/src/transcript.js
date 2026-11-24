/**
 * Maps an OpenCode / Kilo Code session (the `client.session.messages()` list:
 * `{ info, parts }[]`) to EverMe agent-memory messages.
 *
 * Source shapes (from @opencode-ai/sdk 1.19.4 types.gen.d.ts; Kilo's SDK
 * declares the same types):
 *   UserMessage      { id, role:"user", time.created }
 *   AssistantMessage { id, role:"assistant", parentID, time.completed?, finish? }
 *   TextPart         { id, type:"text", text, synthetic?, ignored? }
 *   ToolPart         { id, type:"tool", callID, tool, state }
 *     state: pending | running | completed{input,output,time} | error{input,error,time}
 *
 * Synthetic and ignored text parts are host or plugin additions (our own
 * <everme_recall> part is synthetic), never the user's words. Reasoning,
 * step, file, patch, agent, subtask and compaction parts carry no
 * conversation text.
 */

const USER = "user";
const ASSISTANT = "assistant";
const TOOL = "tool";
const NOT_FINAL_FINISH = new Set(["tool-calls", "tool_calls", "unknown"]);

function textOf(parts, { userOnly }) {
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .filter((part) => !userOnly || (!part.synthetic && !part.ignored))
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function argumentsJSON(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return "{}";
  try {
    return JSON.stringify(input);
  } catch {
    return "{}";
  }
}

/**
 * Returns { entries, ready }.
 *
 * entries carry `sourceRecordId` (the native message or part id) so the
 * checkpoint can tell what was already uploaded. `ready` is false while the
 * newest assistant message is still running or a tool call is unfinished:
 * capture waits for the next idle instead of uploading half a turn.
 */
export function mapSession(list = []) {
  const entries = [];
  let ready = true;
  const items = Array.isArray(list) ? list : [];
  for (const item of items) {
    const info = item?.info;
    const parts = Array.isArray(item?.parts) ? item.parts : [];
    if (!info?.id) continue;
    if (info.role === USER) {
      const content = textOf(parts, { userOnly: true });
      if (content) {
        entries.push({ sourceRecordId: info.id, role: USER, content, timestamp: info.time?.created });
      }
      continue;
    }
    if (info.role !== ASSISTANT) continue;
    const completed = Number.isFinite(info.time?.completed);
    let text = [];
    let textId = "";
    const flush = (final) => {
      const content = text.join("\n").trim();
      if (content) {
        entries.push({
          sourceRecordId: textId || info.id,
          role: ASSISTANT,
          content,
          timestamp: info.time?.created,
          turnComplete: final && completed && Boolean(info.finish) && !NOT_FINAL_FINISH.has(info.finish),
        });
      }
      text = [];
      textId = "";
    };
    for (const part of parts) {
      if (part?.type === "text" && typeof part.text === "string" && !part.synthetic && !part.ignored) {
        if (!textId) textId = part.id || "";
        text.push(part.text);
        continue;
      }
      if (part?.type !== "tool") continue;
      flush(false);
      const state = part.state || {};
      if (state.status !== "completed" && state.status !== "error") {
        ready = false;
        continue;
      }
      if (typeof part.callID !== "string" || !part.callID.trim() || typeof part.tool !== "string" || !part.tool.trim()) {
        continue;
      }
      entries.push({
        sourceRecordId: part.id || part.callID,
        role: ASSISTANT,
        toolCalls: [{ id: part.callID, type: "function", name: part.tool, arguments: argumentsJSON(state.input) }],
        timestamp: state.time?.start ?? info.time?.created,
        turnComplete: false,
      });
      entries.push({
        sourceRecordId: part.id || part.callID,
        role: TOOL,
        toolCallId: part.callID,
        content: state.status === "completed" ? String(state.output ?? "") : String(state.error ?? ""),
        timestamp: state.time?.end ?? info.time?.created,
      });
    }
    flush(true);
    if (!completed) ready = false;
  }
  return { entries, ready };
}

export function entryKey(entry) {
  return JSON.stringify([entry.sourceRecordId, entry.role, entry.toolCallId || ""]);
}

export function lastTurnStart(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].role === USER) return i;
  }
  return 0;
}

export function stripSource({ sourceRecordId, ...message }) {
  return message;
}
