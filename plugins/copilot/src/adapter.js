import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { AGENT_MEMORY_ROLES, turnOrdinals } from "@everme/agent-sdk";
import { readEvents, extractMessages, resolveTurnKey, lastTurn } from "./transcript.js";

const PKG_VERSION = createRequire(import.meta.url)("../package.json").version;

// Copilot CLI names its config-file hook events in camelCase. Both capture
// events map to Stop: agentStop closes each turn, and sessionEnd (once per
// turn in prompt mode, on exit or /clear interactively) re-runs the same
// checkpointed delta, so a turn agentStop already uploaded is not sent twice.
const EVENT_MAP = Object.freeze({
  sessionStart: "SessionStart",
  userPromptSubmitted: "UserPromptSubmit",
  agentStop: "Stop",
  sessionEnd: "Stop",
});

const CONTEXT_EVENTS = new Set(["sessionStart", "userPromptSubmitted"]);

export function copilotConfigDir(env = process.env) {
  return env.EVERCLI_COPILOT_CONFIG_DIR || env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
}

export function sessionEventsPath(sessionId, env = process.env) {
  return path.join(copilotConfigDir(env), "session-state", sessionId, "events.jsonl");
}

export const copilotAdapter = {
  platform: "copilot-cli",
  version: PKG_VERSION,
  turnBoundary: "stop",
  taskBatching: true,

  mapEvent(event) {
    return EVENT_MAP[event] || event;
  },

  envFile() {
    return process.env.EVERME_ENV_FILE_PATH || path.join(copilotConfigDir(), "everme.env");
  },

  // Config-file hooks receive camelCase fields. sessionEnd carries no
  // transcriptPath, so the events file is derived from the session id; the
  // derived path is the same one agentStop reports.
  normalizeInput(rawInput) {
    const sessionId = rawInput?.sessionId || rawInput?.session_id || "";
    const transcriptPath = rawInput?.transcriptPath || rawInput?.transcript_path
      || (sessionId ? sessionEventsPath(sessionId) : "");
    return {
      sessionId,
      transcriptPath,
      cwd: rawInput?.cwd || "",
      prompt: rawInput?.prompt || "",
      source: rawInput?.source || "",
    };
  },

  async resolveTurnId(input) {
    if (!input?.transcriptPath) return "";
    return resolveTurnKey(await readEvents(input.transcriptPath));
  },

  async readLastTurn(input) {
    if (!input?.transcriptPath) return [];
    return lastTurn(extractMessages(await readEvents(input.transcriptPath)));
  },

  async readStoreBatches(input, { checkpointStore, resumeFromStart = false } = {}) {
    if (!input?.transcriptPath || !input?.sessionId) return [];
    const lines = await readEvents(input.transcriptPath);
    const stateId = `copilot-cli:${input.sessionId}`;
    const checkpoint = checkpointStore
      ? await checkpointStore.read(stateId)
      : { initialized: false, uploadedCount: 0 };
    return nativeBatches(input, lines, checkpoint, stateId, resumeFromStart, checkpointStore);
  },

  formatOutput(event, { block = "" } = {}) {
    if (!CONTEXT_EVENTS.has(event) || !block) return {};
    return { additionalContext: block };
  },
};

function countTurns(messages) {
  const starts = messages.filter((message) => message?.role === AGENT_MEMORY_ROLES.USER).length;
  return starts > 0 ? starts : 1;
}

// Same contract as @everme/qwenwork's native checkpoint: the key is the
// source event id plus role and tool call id, the first Stop after install
// uploads only the newest turn, and a Stop that died before committing makes
// the next one resume from the start of the session.
async function nativeBatches(input, lines, checkpoint, stateId, resumeFromStart, checkpointStore) {
  const entries = extractMessages(lines, { sourceIdentity: true });
  const seen = new Set(checkpoint.nativeMessageIds || []);
  const messages = [];
  const fromStart = Boolean(checkpoint.initialized) || resumeFromStart;
  const start = fromStart ? 0 : entries.length - lastTurn(entries).length;
  const skipped = [];
  let firstIndex = -1;
  for (const [index, { sourceRecordId, ...message }] of entries.entries()) {
    if (typeof sourceRecordId !== "string" || !sourceRecordId.trim()) {
      throw new Error("copilot_native_checkpoint_missing_record_id");
    }
    const key = JSON.stringify([sourceRecordId, message.role, message.toolCallId || ""]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (index >= start) {
      if (firstIndex < 0) firstIndex = index;
      messages.push(message);
    } else {
      skipped.push(key);
    }
  }
  if (!messages.length) return [];
  if (!fromStart && skipped.length && typeof checkpointStore?.commit === "function") {
    await checkpointStore.commit(stateId, start, { nativeMessageIds: skipped });
  }
  const addressed = fromStart || firstIndex === 0;
  return [{
    conversationId: input.sessionId,
    messages,
    channel: "hook",
    ...(addressed ? { baseTurn: turnOrdinals(entries)[firstIndex] } : {}),
    turns: addressed ? countTurns(messages) : 0,
    deduplication: "client-native-id",
    checkpoint: { stateId, uploadedCount: entries.length, nativeMessageIds: [...seen] },
  }];
}
