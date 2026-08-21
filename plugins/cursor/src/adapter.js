import os from "node:os";
import path from "node:path";
import { createToolEventBuffer } from "@everme/agent-sdk";
import { readLastTurn } from "./transcript.js";

const EVENT_MAP = {
  sessionStart: "SessionStart",
  stop: "Stop",
  preCompact: "PreCompact",
  postToolUse: "PostToolUse",
};

export const cursorAdapter = {
  platform: "cursor",

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
      turnId: rawInput?.generation_id || "",
      transcriptPath: rawInput?.transcript_path || process.env.CURSOR_TRANSCRIPT_PATH || "",
      workspaceRoots,
      cwd: workspaceRoots[0] || process.env.CURSOR_PROJECT_DIR || "",
      cursorVersion: rawInput?.cursor_version || process.env.CURSOR_VERSION || "",
    };
    if (hostEvent === "postToolUse") {
      input.tool = {
        name: rawInput?.tool_name || rawInput?.name || "",
        input: rawInput?.tool_input ?? rawInput?.input ?? "",
        output: rawInput?.tool_output ?? rawInput?.output ?? "",
      };
    }
    return input;
  },

  // Cursor's transcript intentionally omits tool outputs, so postToolUse
  // spools each call locally and the Stop hook attaches the spool to the
  // turn it uploads. No network happens here.
  async bufferToolUse(input, { stateDir, maxBytes, warn = warnSpoolFull } = {}) {
    if (!input?.sessionId || !input.tool) return { block: "", count: 0 };
    const buffer = createToolEventBuffer({ stateDir, maxBytes });
    const { dropped } = await buffer.append(input.sessionId, {
      generationId: input.turnId,
      name: input.tool.name,
      input: input.tool.input,
      output: input.tool.output,
    });
    if (dropped) {
      // The cap protects the disk from a runaway turn, but a capped call
      // must not vanish silently — that is the failure mode this spool
      // exists to fix.
      warn(`EverMe Cursor tool call spool is full for ${input.sessionId}; this call will be missing from the saved turn`);
      return { block: "", count: 0 };
    }
    return { block: "", count: 1 };
  },

  async readLastTurn(input, { stateDir } = {}) {
    const transcript = await readLastTurn(input?.transcriptPath, {
      warn: (type) => warnUnknownRecordType(type),
    });
    if (!input?.sessionId) return transcript;
    const buffer = createToolEventBuffer({ stateDir });
    const events = await buffer.drain(input.sessionId, { generationId: input?.turnId || "" });
    if (!events.length) return transcript;

    // The spool carries inputs AND outputs while transcript tool records
    // carry inputs only, and the two sides share no reliable call id to
    // dedupe on — so a non-empty spool supersedes the transcript's tool
    // data entirely. Text messages always come from the transcript.
    const text = transcript
      .filter((message) => message.role !== "tool" && (message.content || !message.toolCalls))
      .map(({ toolCalls, ...message }) => message);
    const pairs = events.flatMap((event, index) => {
      const id = event.id || `cursor_tool_${event.ts || "untimed"}_${index}`;
      const stamp = Number.isFinite(event.ts) ? { timestamp: event.ts } : {};
      return [
        {
          role: "assistant",
          ...stamp,
          toolCalls: [{ id, type: "function", name: event.name || "unknown", arguments: argumentText(event.input) }],
        },
        { role: "tool", ...stamp, toolCallId: id, content: contentText(event.output) },
      ];
    });
    const head = text.length && text[0].role === "user" ? [text[0]] : [];
    return [...head, ...pairs, ...text.slice(head.length)];
  },

  formatOutput(event, { block = "" } = {}) {
    if (event !== "sessionStart" || !block) return {};
    return { additional_context: block };
  },
};

function argumentText(value) {
  if (typeof value === "string") return value || "{}";
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function contentText(value) {
  if (typeof value === "string") return value || "tool result";
  if (value == null) return "tool result";
  try {
    return JSON.stringify(value) || "tool result";
  } catch {
    return "tool result";
  }
}

function warnUnknownRecordType(type) {
  try {
    process.stderr.write(`EverMe Cursor transcript: unknown record type ${type}\n`);
  } catch {
    // A closed stderr must never break a hook.
  }
}

function warnSpoolFull(line) {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // A closed stderr must never break a hook.
  }
}
