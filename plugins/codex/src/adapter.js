import os from "node:os";
import path from "node:path";
import { readLastTurn } from "./transcript.js";

const CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);

export const codexAdapter = {
  platform: "codex",

  envFile() {
    return process.env.EVERME_ENV_FILE_PATH || path.join(os.homedir(), ".codex", "everme.env");
  },

  normalizeInput(rawInput) {
    return {
      // No session_id → empty (writes are skipped downstream), like
      // cursor/devin: a constant fallback would merge unrelated sessions
      // into one conversation on the backend.
      sessionId: rawInput?.session_id || "",
      transcriptPath: rawInput?.transcript_path || "",
      cwd: rawInput?.cwd || "",
      prompt: rawInput?.prompt || "",
      turnId: rawInput?.turn_id || "",
      source: rawInput?.source || "",
    };
  },

  readLastTurn(input) {
    return readLastTurn(input?.transcriptPath);
  },

  formatOutput(event, { block = "" } = {}) {
    if (!CONTEXT_EVENTS.has(event) || !block) return {};
    return {
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: block,
      },
    };
  },
};
