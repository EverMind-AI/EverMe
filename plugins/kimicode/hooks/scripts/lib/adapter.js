import os from "node:os";
import path from "node:path";
import { readLastTurn, readSession } from "./kimi-transcript.js";

const CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);

// A single Kimi Code turn (a prompt + a short answer) is too thin for the
// backend to extract an episodic memory, so kimicode registers no Stop hook
// and persists the WHOLE session once at SessionEnd instead. Below this
// floor there is no episode to extract, so the write is skipped entirely.
const MIN_SESSION_MESSAGES = 2;

export const kimiCodeAdapter = {
  platform: "kimi-code",

  envFile() {
    const home = process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
    return process.env.EVERME_ENV_FILE_PATH || path.join(home, "everme.env");
  },

  normalizeInput(rawInput) {
    return {
      sessionId: rawInput?.session_id || "kimi-code-session",
      cwd: rawInput?.cwd || process.cwd(),
      prompt: rawInput?.prompt || "",
      turnId: rawInput?.turn_id || "",
      source: rawInput?.source || "",
    };
  },

  readLastTurn(input) {
    return readLastTurn({ sessionId: input?.sessionId, cwd: input?.cwd });
  },

  async readSession(input) {
    const messages = await readSession({ sessionId: input?.sessionId, cwd: input?.cwd });
    return messages.length >= MIN_SESSION_MESSAGES ? messages : [];
  },

  formatOutput(event, { block = "" } = {}) {
    if (!CONTEXT_EVENTS.has(event) || !block) return {};
    return { message: block };
  },
};
