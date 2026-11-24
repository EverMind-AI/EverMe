import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createToolEventBuffer, redactError } from "@everme/agent-sdk";
import { readLastTurn } from "./transcript.js";

const PKG_VERSION = createRequire(import.meta.url)("../package.json").version;

const EVENT_MAP = {
  sessionStart: "SessionStart",
  stop: "Stop",
  preCompact: "PreCompact",
  postToolUse: "PostToolUse",
  sessionEnd: "SessionEnd",
};

export const cursorAdapter = {
  platform: "cursor",
  version: PKG_VERSION,
  // Exactly one host event maps to Stop and generation_id keys the turn, so
  // one Stop is one logical turn: this host is in both halves of L1-2. It
  // already claimed the channel implicitly by writing through the
  // single-turn path; now that the claim is gated on this declaration, the
  // declaration has to be here or cursor would silently leave the numerator.
  turnBoundary: "stop",
  taskBatching: true,
  // cursor-agent -p fires sessionEnd but no stop: its one turn is stored there.
  storeAtSessionEndWithoutStop: true,

  envFile() {
    return process.env.EVERME_ENV_FILE_PATH || path.join(os.homedir(), ".cursor", "everme.env");
  },

  mapEvent(event) {
    return EVENT_MAP[event] || event;
  },

  normalizeInput(rawInput, hostEvent) {
    const workspaceRoots = Array.isArray(rawInput?.workspace_roots)
      ? rawInput.workspace_roots.filter((root) => typeof root === "string")
      : [];
    const sessionId = rawInput?.conversation_id || rawInput?.session_id || "";
    const input = {
      sessionId,
      // No generation_id → empty turn key (dedup disabled), NOT the
      // conversation id: that constant would mark every turn after the
      // first as a duplicate and silently drop the whole session's writes.
      //
      // sessionEnd gets no turn key: in -p mode its generation_id is the
      // conversation id, the same in every run of the session (checked on
      // 2026-11-20), so it would mark each later run's turn as a duplicate.
      turnId: hostEvent === "sessionEnd" ? "" : rawInput?.generation_id || "",
      transcriptPath: rawInput?.transcript_path || process.env.CURSOR_TRANSCRIPT_PATH || "",
      workspaceRoots,
      cwd: workspaceRoots[0] || process.env.CURSOR_PROJECT_DIR || "",
      cursorVersion: rawInput?.cursor_version || process.env.CURSOR_VERSION || "",
    };
    if (hostEvent === "postToolUse") {
      input.tool = {
        id: rawInput?.tool_use_id,
        name: rawInput?.tool_name,
        input: rawInput?.tool_input,
        output: rawInput?.tool_output,
      };
    }
    return input;
  },

  // Cursor's transcript intentionally omits tool outputs, so postToolUse
  // spools each call locally and the Stop hook attaches the spool to the
  // turn it uploads. No network happens here.
  async bufferToolUse(input, { stateDir, maxBytes, warn = warnSpoolFull } = {}) {
    if (!input?.sessionId || !input.tool) return { block: "", count: 0 };
    const reason = invalidToolReason(input.tool);
    if (reason) {
      warn(`EverMe Cursor ${reason}: dropped_events=1`);
      return { block: "", count: 0 };
    }
    const buffer = createToolEventBuffer({ stateDir, maxBytes });
    const { dropped } = await buffer.append(input.sessionId, {
      generationId: input.turnId,
      id: input.tool.id,
      name: input.tool.name,
      input: encodeArguments(input.tool.input),
      output: redactOutput(input.tool.output),
    });
    if (dropped) {
      // The cap protects the disk from a runaway turn, but a capped call
      // must not vanish silently — that is the failure mode this spool
      // exists to fix.
      warn(`EverMe Cursor tool call spool is full for ${bounded(input.sessionId, 128)}; this call will be missing from the saved turn`);
      return { block: "", count: 0 };
    }
    return { block: "", count: 1 };
  },

  async readLastTurn(input, { stateDir } = {}) {
    const transcript = await readLastTurn(input?.transcriptPath, {
      warn: (reason, count) => warnSpoolFull(`EverMe Cursor transcript ${reason}: dropped_items=${count}`),
    });
    if (!input?.sessionId) return transcript;
    const buffer = createToolEventBuffer({ stateDir });
    const events = await buffer.drain(input.sessionId, { generationId: input?.turnId || "" });
    if (!events.length) return transcript;

    // Transcript IDs are not verified to match hook IDs across host versions.
    // Retain the existing spool-authoritative merge; text comes from the transcript.
    const text = transcript
      .filter((message) => message.role !== "tool" && (message.content || !message.toolCalls))
      .map(({ toolCalls, ...message }) => message);
    const rejected = new Map();
    const pairs = events.flatMap((event) => {
      const tool = { ...event, input: parseObject(event.input) };
      const reason = invalidToolReason(tool);
      if (reason) {
        rejected.set(reason, (rejected.get(reason) || 0) + 1);
        return [];
      }
      const id = event.id;
      const stamp = Number.isFinite(event.ts) ? { timestamp: event.ts } : {};
      return [
        {
          role: "assistant",
          ...stamp,
          toolCalls: [{ id, type: "function", name: event.name, arguments: encodeArguments(tool.input) }],
        },
        { role: "tool", ...stamp, toolCallId: id, content: redactOutput(event.output) },
      ];
    });
    for (const [reason, count] of rejected) warnSpoolFull(`EverMe Cursor ${reason}: dropped_events=${count}`);
    if (!pairs.length) return transcript;
    const head = text.length && text[0].role === "user" ? [text[0]] : [];
    return [...head, ...pairs, ...text.slice(head.length)];
  },

  formatOutput(event, { block = "" } = {}) {
    if (event !== "sessionStart" || !block) return {};
    return { additional_context: block };
  },
};

function parseObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function invalidToolReason(tool) {
  if (typeof tool.id !== "string" || !tool.id.trim()) return "invalid_tool_id";
  if (typeof tool.name !== "string" || !tool.name.trim()) return "invalid_tool_name";
  if (!tool.input || typeof tool.input !== "object" || Array.isArray(tool.input)) return "invalid_tool_arguments";
  if (typeof tool.output !== "string") return "invalid_tool_output";
  return "";
}

function encodeArguments(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "string" ? redactError(item) : item);
}

function redactOutput(value) {
  try {
    JSON.parse(value);
    // Redact JSON string tokens without re-encoding numbers or whitespace.
    return value.replace(/"(?:\\.|[^"\\])*"/g, literal => {
      const text = JSON.parse(literal);
      const redacted = redactError(text);
      return text === redacted ? literal : JSON.stringify(redacted);
    });
  } catch {
    return redactError(value);
  }
}

function warnSpoolFull(line) {
  try {
    process.stderr.write(`${bounded(line, 240)}\n`);
  } catch {
    // A closed stderr must never break a hook.
  }
}

function bounded(value, limit) {
  const text = redactError(value).replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
