import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { completedTurns, turnOrdinals } from "@everme/agent-sdk";
import { readAgentSessions, readLastTurn, readSession } from "./kimi-transcript.js";

const PKG_VERSION = createRequire(import.meta.url)("../../../package.json").version;

const CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);

// Kimi Code 2.6 sends the UserPromptSubmit prompt as content parts
// ([{type: "text", text}, ...]); earlier releases sent a string.
function promptText(prompt) {
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt)) return "";
  return prompt
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export const kimiCodeAdapter = {
  platform: "kimi-code",
  version: PKG_VERSION,
  taskBatching: true,

  envFile() {
    const home = process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
    return process.env.EVERME_ENV_FILE_PATH || path.join(home, "everme.env");
  },

  normalizeInput(rawInput, event) {
    const sessionId = rawInput?.session_id;
    return {
      sessionId: typeof sessionId === "string" && sessionId.trim() ? sessionId : "",
      cwd: rawInput?.cwd || process.cwd(),
      prompt: promptText(rawInput?.prompt),
      turnId: rawInput?.turn_id || "",
      source: rawInput?.source || "",
      isSubagent: event === "SubagentStop",
    };
  },

  readLastTurn(input) {
    return readLastTurn({ sessionId: input?.sessionId, cwd: input?.cwd });
  },

  async readSession(input) {
    return readSession({ sessionId: input?.sessionId, cwd: input?.cwd });
  },

  async readStoreBatches(input, options) {
    if (!input?.isSubagent) return null;
    return agentBatches(input, { ...options, includeMain: false });
  },

  readSessionBatches(input, options) {
    return agentBatches(input, { ...options, includeMain: true });
  },

  formatOutput(event, { block = "" } = {}) {
    if (!CONTEXT_EVENTS.has(event) || !block) return {};
    return { message: block };
  },
};

async function agentBatches(input, { checkpointStore, includeMain }) {
  const sessions = await readAgentSessions({
    sessionId: input.sessionId,
    cwd: input.cwd,
    includeMain,
  });
  const batches = [];
  for (const session of sessions) {
    if (session.agentId !== "main" && !session.messages.some((message) => message.role === "user")) {
      console.warn("[everme] kimicode store stage=skip reason=subagent_without_user");
      continue;
    }
    const conversationId = session.agentId === "main"
      ? input.sessionId
      : `${input.sessionId}__${session.agentId}`;
    const stateId = `kimicode:${conversationId}`;
    const checkpoint = checkpointStore
      ? await checkpointStore.read(stateId)
      : { initialized: false, uploadedCount: 0 };
    const continuation = checkpoint.initialized && checkpoint.uploadedCount <= session.messages.length;
    const delta = continuation ? session.messages.slice(checkpoint.uploadedCount) : session.messages;
    if (!delta.length) continue;
    // The whole transcript is in hand, so the delta is addressed by
    // absolute turn (a continuation starts at the ordinal of its first
    // message, a first upload at 0) and declares the turns it completes;
    // the session gate then trims the importer's later scan of the same
    // wire.jsonl instead of storing it twice.
    const baseTurn = continuation ? turnOrdinals(session.messages)[checkpoint.uploadedCount] : 0;
    batches.push({
      conversationId,
      messages: delta,
      baseTurn,
      turns: completedTurns([delta], 0, baseTurn),
      checkpoint: { stateId, uploadedCount: session.messages.length },
    });
  }
  return batches;
}
