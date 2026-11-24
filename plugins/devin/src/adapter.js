import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { promptKey, takePrompt } from "./pending-prompt.js";
import { readLastTurn } from "./transcript.js";
import { messagesForEvent } from "./turn.js";

const PKG_VERSION = createRequire(import.meta.url)("../package.json").version;

// Devin Desktop 3.9.19 removed Cascade; Devin Local is its only agent.
// Devin Local fires Claude Code-shaped events from ~/.config/devin/config.json
// (probed on 3.14.30819): UserPromptSubmit carries `prompt` and `prompt_id`,
// Stop carries `last_assistant_message` and the same `prompt_id`. The
// Cascade events below stay for installs on a Devin older than 3.9.19.
const LOCAL_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "Stop"]);
const CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);
const CASCADE_TRANSCRIPT_EVENT = "post_cascade_response_with_transcript";
const CASCADE_WRITE_EVENTS = new Set([CASCADE_TRANSCRIPT_EVENT, "post_cascade_response", "post_run_command", "post_read_code"]);

export const devinAdapter = {
  platform: "devin",
  version: PKG_VERSION,
  taskBatching: true,

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
    if (LOCAL_EVENTS.has(event)) return event;
    return CASCADE_WRITE_EVENTS.has(event) ? "Stop" : event;
  },

  normalizeInput(rawInput, event) {
    if (LOCAL_EVENTS.has(event)) {
      return {
        local: true,
        event,
        sessionId: nativeId(rawInput?.session_id),
        turnId: nativeId(rawInput?.prompt_id),
        prompt: typeof rawInput?.prompt === "string" ? rawInput.prompt : "",
        lastAssistantMessage: typeof rawInput?.last_assistant_message === "string" ? rawInput.last_assistant_message : "",
        // Devin Local sends no timestamp; the hook runs as the event happens.
        timestamp: rawInput?.timestamp || new Date().toISOString(),
      };
    }
    return {
      sessionId: nativeId(rawInput?.trajectory_id),
      turnId: nativeId(rawInput?.execution_id),
      // The event decides which shape tool_info has, so readLastTurn needs
      // to know which one it was handed.
      event: rawInput?.agent_action_name || event || "",
      toolInfo: rawInput?.tool_info && typeof rawInput.tool_info === "object" ? rawInput.tool_info : {},
      transcriptPath: rawInput?.tool_info?.transcript_path || "",
      timestamp: rawInput?.timestamp || "",
      modelName: rawInput?.model_name || "",
    };
  },

  async readLastTurn(input, options = {}) {
    if (input?.local) {
      const pending = await takePrompt(promptKey(input.sessionId, input.turnId), options);
      return messagesForEvent("Stop", input, pending, options);
    }
    // Only the _with_transcript variant names a file.
    if (input?.transcriptPath) return readLastTurn(input.transcriptPath, options);
    const pending = input?.event === "post_cascade_response"
      ? await takePrompt(input?.sessionId, options)
      : null;
    return messagesForEvent(input?.event, input, pending, options);
  },

  // Devin Local reads additionalContext from SessionStart and
  // UserPromptSubmit (verified: both blocks reached the model on 3.14.30819).
  formatOutput(event, { block = "" } = {}) {
    if (!CONTEXT_EVENTS.has(event) || !block) return {};
    return { hookSpecificOutput: { hookEventName: event, additionalContext: block } };
  },
};

function nativeId(value) {
  return typeof value === "string" && value.trim() ? value : "";
}
