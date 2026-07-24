import os from "node:os";
import path from "node:path";
import { readTranscript, extractAgentMessages } from "./transcript.js";

const CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);

export const claudeCodeAdapter = {
  platform: "claude-code",

  envFile() {
    return process.env.EVERME_ENV_FILE_PATH || path.join(os.homedir(), ".claude", "everme.env");
  },

  normalizeInput(rawInput) {
    return {
      sessionId: rawInput?.session_id || "claude-code-session",
      transcriptPath: rawInput?.transcript_path || "",
      cwd: rawInput?.cwd || "",
      prompt: rawInput?.prompt || "",
      turnId: rawInput?.turn_id || "",
      source: rawInput?.source || "",
    };
  },

  // Claude Code's documented Stop stdin carries no turn_id (only
  // session_id / transcript_path / cwd / stop_hook_active), so keying dedup
  // on rawInput.turn_id alone never fires. Derive a stable per-turn key
  // from the transcript instead: the uuid of the last recorded event. A
  // re-fired Stop over an unchanged transcript resolves to the same key and
  // is deduped; a new turn appends new events and yields a new key. Returns
  // "" (dedup disabled) when the transcript has no uuids.
  async resolveTurnId(input) {
    if (!input?.transcriptPath) return "";
    const lines = await readTranscript(input.transcriptPath);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const event = JSON.parse(lines[index]);
        if (typeof event?.uuid === "string" && event.uuid) return event.uuid;
      } catch {
        continue;
      }
    }
    return "";
  },

  async readLastTurn(input) {
    if (!input?.transcriptPath) return [];
    const messages = extractAgentMessages(await readTranscript(input.transcriptPath));
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "user") return messages.slice(index);
    }
    return messages;
  },

  formatOutput(event, { block = "", count = 0 } = {}) {
    if (!CONTEXT_EVENTS.has(event) || !block) return {};
    const systemMessage = event === "SessionStart"
      ? `🧠 EverMe loaded ${count} memory ${count === 1 ? "item" : "items"} from past sessions`
      : `🧠 Recalling ${count} relevant ${count === 1 ? "memory" : "memories"} from EverMe`;
    return {
      systemMessage,
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: block,
      },
    };
  },
};
