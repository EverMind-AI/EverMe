import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { readTranscript, extractAgentMessages } from "./transcript.js";
import { turnOrdinals } from "@everme/agent-sdk";

const PKG_VERSION = createRequire(import.meta.url)("../../../package.json").version;

const CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);
const WRITE_EVENTS = new Set(["Stop", "SubagentStop", "SessionEnd", "PreCompact"]);

export const claudeCodeAdapter = {
  platform: "claude-code",
  version: PKG_VERSION,
  // One hook invocation is one logical turn and the delivery marker runs on
  // every one of them, so the SDK claims channel="hook" for these writes and
  // they enter L1-2's denominator. Whole-session hosts leave this unset.
  turnBoundary: "stop",
  taskBatching: true,
  // This host ships the mem_skill tool alongside the hook, so an injected
  // skill id is resolvable. Hosts without it must leave this unset: an id
  // the model cannot redeem is pure noise.
  skillFetch: true,

  envFile() {
    return process.env.EVERME_ENV_FILE_PATH || path.join(os.homedir(), ".claude", "everme.env");
  },

  normalizeInput(rawInput, event) {
    const isSubagent = event === "SubagentStop";
    const parentSessionId = nativeId(rawInput?.session_id);
    const agentId = nativeId(rawInput?.agent_id);
    const missingIdentity = !parentSessionId
      ? "missing_session_id"
      : isSubagent && !agentId ? "missing_agent_id" : "";
    if (missingIdentity && WRITE_EVENTS.has(event)) logSkippedWrite(missingIdentity);
    return {
      sessionId: missingIdentity ? "" : isSubagent ? `${parentSessionId}__${agentId}` : parentSessionId,
      transcriptPath: isSubagent
        ? rawInput?.agent_transcript_path || ""
        : rawInput?.transcript_path || "",
      cwd: rawInput?.cwd || "",
      prompt: rawInput?.prompt || "",
      turnId: rawInput?.turn_id || "",
      source: rawInput?.source || "",
      isSubagent,
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
    const lines = await readSessionLines(input);
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
    const messages = extractAgentMessages(await readSessionLines(input), {
      subagent: input.isSubagent,
      diagnostic: (line) => console.error(line),
    });
    if (skipUserlessChild(input, messages)) return [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "user") return messages.slice(index);
    }
    return messages;
  },

  async readStoreBatches(input, { checkpointStore, resumeFromStart = false } = {}) {
    if (!nativeId(input?.sessionId)) {
      logSkippedWrite("missing_session_id");
      return [];
    }
    if (!input?.transcriptPath) return [];
    const messages = extractAgentMessages(await readSessionLines(input), {
      subagent: input.isSubagent,
      diagnostic: (line) => console.error(line),
    });
    if (skipUserlessChild(input, messages)) return [];
    const stateId = `claude-code:${input.sessionId}`;
    const checkpoint = checkpointStore
      ? await checkpointStore.read(stateId)
      : { initialized: false, uploadedCount: 0 };
    const continuation = checkpoint.initialized && checkpoint.uploadedCount <= messages.length;
    // A cold start sends only the newest turn: older turns predate the
    // install. Not so when an earlier Stop of this session died before it
    // committed (resumeFromStart): those turns are this hook's own.
    const delta = continuation
      ? messages.slice(checkpoint.uploadedCount)
      : (input.isSubagent || resumeFromStart ? messages : lastRootTurn(messages));
    if (!delta.length) return [];
    return [{
      conversationId: input.sessionId,
      messages: delta,
      // Address the delta by its absolute turn only when everything before it
      // is known to be covered: a checkpoint continuation, or the whole
      // transcript. A cold-start tail (no checkpoint yet -- a resumed
      // pre-existing session, a wiped state dir) must not claim the turns it
      // skipped, or the importer would trim the history it still has to bring
      // in; unaddressed, the gate appends it at the current watermark instead.
      ...(continuation || delta.length === messages.length
        ? { baseTurn: turnOrdinals(messages)[messages.length - delta.length] }
        // A cold-start tail also declares no completed turn: appended at the
        // watermark it would be recorded as turn 0 and the importer would
        // then trim the real turn 0 as covered.
        : { turns: 0 }),
      checkpoint: { stateId, uploadedCount: messages.length },
    }];
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

async function readSessionLines(input) {
  const lines = await readTranscript(input.transcriptPath);
  if (input.isSubagent || !nativeId(input.sessionId)) return lines;
  let excluded = 0;
  const selected = lines.filter((line) => {
    try {
      const sessionId = nativeId(JSON.parse(line)?.sessionId);
      if (sessionId && sessionId !== input.sessionId) {
        excluded++;
        return false;
      }
    } catch {
      // Leave malformed records to the existing parser.
    }
    return true;
  });
  if (excluded) console.error(`[everme] claude-code parse reason=claude_inherited_history excluded_records=${excluded}`);
  return selected;
}

function nativeId(value) {
  return typeof value === "string" && value.trim() ? value : "";
}

function skipUserlessChild(input, messages) {
  if (!input.isSubagent || messages.some((message) => message.role === "user")) return false;
  logSkippedWrite("subagent_without_user");
  return true;
}

function logSkippedWrite(reason) {
  console.error(`[everme] claude-code store stage=skip reason=${reason}`);
}

function lastRootTurn(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return messages.slice(index);
  }
  return messages;
}
