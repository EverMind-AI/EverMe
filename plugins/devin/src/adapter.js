import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { takePrompt } from "./pending-prompt.js";
import { readLastTurn } from "./transcript.js";
import { messagesForEvent } from "./turn.js";

// Events Devin emits that close out something worth storing. A real
// session produced post_cascade_response (the answer, inline) and
// post_run_command (the tool call) and never emitted the _with_transcript
// variant — that one is kept only so an older Devin still works.
const TRANSCRIPT_EVENT = "post_cascade_response_with_transcript";
const WRITE_EVENTS = new Set([TRANSCRIPT_EVENT, "post_cascade_response", "post_run_command", "post_read_code"]);

export const devinAdapter = {
  platform: "devin",

  envFile() {
    if (process.env.EVERME_ENV_FILE_PATH) return process.env.EVERME_ENV_FILE_PATH;
    // Devin moved its user config from the Windsurf tree to ~/.config/devin
    // and asks users whether to copy it over, so credentials live in either
    // place depending on when the install happened. Prefer the current
    // location, fall back to the old one, and name the current one when
    // neither exists so the "not configured" path reports today's layout.
    const current = path.join(os.homedir(), ".config", "devin", "everme.env");
    if (existsSync(current)) return current;
    const legacy = path.join(os.homedir(), ".codeium", "windsurf", "everme.env");
    return existsSync(legacy) ? legacy : current;
  },

  mapEvent(event) {
    return WRITE_EVENTS.has(event) ? "Stop" : event;
  },

  normalizeInput(rawInput, event) {
    return {
      sessionId: rawInput?.trajectory_id || "",
      turnId: rawInput?.execution_id || "",
      // The event decides which shape tool_info has, so readLastTurn needs
      // to know which one it was handed.
      event: rawInput?.agent_action_name || event || "",
      toolInfo: rawInput?.tool_info && typeof rawInput.tool_info === "object" ? rawInput.tool_info : {},
      transcriptPath: rawInput?.tool_info?.transcript_path || "",
      timestamp: rawInput?.timestamp || "",
      modelName: rawInput?.model_name || "",
    };
  },

  async readLastTurn(input) {
    // Only the _with_transcript variant names a file; the events Devin
    // actually emits carry their content in tool_info.
    if (input?.transcriptPath) return readLastTurn(input.transcriptPath);
    const pending = input?.event === "post_cascade_response"
      ? await takePrompt(input?.sessionId)
      : "";
    return messagesForEvent(input?.event, input, pending);
  },

  formatOutput() {
    return {};
  },
};
