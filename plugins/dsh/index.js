import { createRequire } from "node:module";

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import {
  assertConfigUsable,
  createClient,
  deliveryFailReason,
  extractText,
  recordDelivery,
  redactError,
  resolveConfig,
  runInject,
  saveAgentMemory,
  toText,
} from "@everme/agent-sdk";

// This is a host-native integration (DeepSeek Harness Cordis hooks), not an
// MCP transport, so it declares the same "hook" kind as the native hooks.
// dsh declares "type": "module" like every other protocol package.
const PKG_VERSION = createRequire(import.meta.url)("./package.json").version;

export const name = "everme";
export const inject = ["agents"];

export function apply(ctx, config = {}) {
  installEverMeHooks(ctx, config);
}

export function installEverMeHooks(ctx, config = {}, dependencies = {}) {
  const log = createLogger(ctx, dependencies.log);
  const resolved = dependencies.config || resolveConfig({ ...config, clientKind: "hook", clientVersion: PKG_VERSION });
  try {
    assertConfigUsable(resolved);
  } catch (error) {
    log.warn(`[everme] native hooks disabled: ${safeError(error)}`);
    return { enabled: false };
  }

  const client = dependencies.client || createClient(resolved, log);
  const recall = dependencies.runInject || runInject;
  const save = dependencies.saveAgentMemory || saveAgentMemory;
  const makeUserMessage = dependencies.createUserMessage || createUserMessage;
  const pending = new WeakMap();
  const record = (kind, reason = null) => recordDelivery("dsh", kind, { reason, pluginVersion: PKG_VERSION, agentId: resolved.agentId }, log);

  ctx.on("agent/pre-step", async ({ messages, step, signal }, next) => {
    const decision = await next();
    if (decision.kind !== "enter" || signal.aborted || step !== 1) return decision;

    try {
      const prompt = humanPrompt(decision.messages || messages);
      if (!prompt) return decision;
      const result = await recall({ input: { prompt }, client, config: resolved, log });
      if (!result?.block) return decision;
      return {
        kind: "enter",
        messages: [
          ...decision.messages,
          makeUserMessage({
            content: [{ type: "text", text: result.block }],
            source: {
              kind: "everme",
              form: "snapshot",
              sections: [{ name: "everme-recall", text: result.block }],
            },
          }),
        ],
      };
    } catch (error) {
      log.warn(`[everme] recall degraded open: ${safeError(error)}`);
      return decision;
    }
  }, { prepend: true });

  ctx.on("session/event", (session, event) => {
    if (event?.type !== "turn/end") return;
    if (!validId(session?.id)) {
      log.warn("[everme] conversion reason=invalid_session_id dropped=1");
      return;
    }
    const turn = event.data?.turn;
    const messages = collectTurnMessages(session, turn, event.seq, log, record);
    if (!messages.length) return;
    if (isNativeSubagent(session) && !hasHumanInput(session, event.seq)) {
      log.warn("[everme] conversion reason=subagent_without_user skipped=1");
      return;
    }
    enqueue(pending, session, async () => {
      let result;
      try {
        result = await save(client, {
          conversationId: session.id,
          messages,
          taskBatching: true,
          flush: true,
          // The host numbers turns from 1; the gate's whole-turn ordinals
          // start at 0. Claiming the hook channel lets the gate advance its
          // turn watermark for this live writer.
          channel: "hook",
          baseTurn: turn - 1,
        }, log);
      } catch (error) {
        record("fail", deliveryFailReason(error));
        throw error;
      }
      // null means nothing was sent, so it must not move the last-ok time.
      if (result !== null) record("ok");
    }, log);
  });

  ctx.on("session/flush", async (session) => {
    await (pending.get(session) || Promise.resolve());
  });

  return { enabled: true, pending };
}

export function collectTurnMessages(session, turn, endSeq = Number.POSITIVE_INFINITY, log = { warn() {} }, record = () => {}) {
  const events = sessionEvents(session);
  if (!events) record("skip", "session_unreadable");
  if (!events || !Number.isSafeInteger(turn)) return [];
  let startIndex = -1;
  let endIndex = events.length;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.seq > endSeq) continue;
    if (event?.type === "turn/end" && event.data?.turn === turn) {
      endIndex = index + 1;
      continue;
    }
    if (event?.type === "turn/start" && event.data?.turn === turn) {
      startIndex = index;
      break;
    }
  }
  if (startIndex < 0) {
    log.warn("[everme] conversion reason=missing_turn_start dropped=1");
    return [];
  }

  const messages = [];
  const rejected = new Map();
  const reject = (reason) => rejected.set(reason, (rejected.get(reason) || 0) + 1);
  const turnEvents = events.slice(startIndex + 1, endIndex);
  const invalidResults = rejectedResultIDs(turnEvents);
  const nativeSubagent = isNativeSubagent(session);
  const lastSurface = turnEvents.findLast(event => ["user/message", "assistant/message", "tool/result"].includes(event.type));
  const completed = turnEvents.at(-1)?.type === "turn/end" && turnEvents.at(-1).data?.reason?.kind === "completed";
  for (const event of turnEvents) {
    const converted = convertSessionEvent(event, reject, nativeSubagent);
    if (converted?.role === "tool" && invalidResults.has(converted.toolCallId)) {
      reject(invalidResults.get(converted.toolCallId));
      continue;
    }
    if (converted?.role === "assistant") {
      const original = event.data?.message?.content || [];
      converted.turnComplete = completed && event === lastSurface && !event.data?.interrupted
        && !original.some(block => block.type === "tool-call")
        && converted.content.some(block => block.type === "text" && block.text.trim());
    }
    if (converted) messages.push(converted);
  }
  for (const [reason, count] of rejected) log.warn(`[everme] conversion reason=${reason} dropped=${count}`);
  return messages;
}

// DSH 0.1.7 (session format v4) no longer exposes the `events` array; hosts
// older than 0.1.2 have no snapshotEvents().
function sessionEvents(session) {
  if (typeof session?.snapshotEvents === "function") return session.snapshotEvents();
  return Array.isArray(session?.events) ? session.events : null;
}

function isNativeSubagent(session) {
  if (session.header?.origin !== "subagent") return false;
  const descriptor = sessionEvents(session)?.find(event => event.type === "subagent/descriptor")?.data;
  return descriptor?.version === 3 && ["one-shot", "continuable"].includes(descriptor.mode);
}

function hasHumanInput(session, endSeq) {
  return sessionEvents(session)?.some(event => event.seq <= endSeq && event.type === "user/message"
    && convertSessionEvent(event, () => {}, true)?.role === "user");
}

function convertSessionEvent(event, reject, nativeSubagent) {
  if (event?.type === "user/message") {
    const message = event.data;
    if (message?.source?.kind !== "user") {
      reject("non_user_source");
      return null;
    }
    if (nativeSubagent && !("rpcId" in message.source)) {
      reject("delegated_task");
      return null;
    }
    const content = extractText(message.content).trim();
    if (!content) reject("empty_message");
    return content ? { role: "user", content, timestamp: event.time } : null;
  }

  if (event?.type === "assistant/message") {
    const content = normalizeAssistantContent(event.data?.message?.content, reject);
    if (!content.length) reject("empty_message");
    return content.length ? { role: "assistant", content, timestamp: event.time } : null;
  }

  if (event?.type === "tool/result") {
    const block = event.data?.message?.content?.find((item) => item?.type === "tool-result");
    if (!validId(block?.toolCallId)) {
      reject("invalid_tool_result_id");
      return null;
    }
    if (!Array.isArray(block.content)) {
      reject("invalid_tool_result_content");
      return null;
    }
    return {
      role: "tool",
      toolCallId: block.toolCallId,
      content: block.content,
      timestamp: event.time,
    };
  }

  if (!["turn/start", "turn/end", "step/start", "step/end", "tool/call"].includes(event?.type)) reject("non_dialogue_event");
  return null;
}

function normalizeAssistantContent(content, reject) {
  const normalized = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === "text" && block.text) {
      normalized.push({ type: "text", text: block.text });
    } else if (block?.type === "tool-call") {
      const reason = invalidCallReason(block);
      if (reason) {
        reject(reason);
        continue;
      }
      normalized.push({
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: block.arguments || "{}",
      });
    } else if (block?.type !== "text") {
      reject("non_dialogue_content");
    }
  }
  return normalized;
}

function validId(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function rejectedResultIDs(events) {
  const counts = new Map();
  const invalid = new Map();
  for (const event of events) {
    if (event.type !== "assistant/message") continue;
    for (const block of event.data?.message?.content || []) {
      if (block.type !== "tool-call" || !validId(block.id)) continue;
      counts.set(block.id, (counts.get(block.id) || 0) + 1);
      const reason = invalidCallReason(block);
      if (reason) invalid.set(block.id, reason);
    }
  }
  // Duplicate native IDs do not identify which call owns a result.
  return new Map([...invalid].filter(([id]) => counts.get(id) === 1));
}

function invalidCallReason(block) {
  if (!validId(block.id)) return "invalid_tool_call_id";
  if (!validId(block.name)) return "invalid_tool_name";
  if (typeof block.arguments !== "string") return "invalid_tool_arguments";
  try {
    JSON.parse(block.arguments || "{}");
  } catch {
    return "invalid_tool_arguments";
  }
  return "";
}

function humanPrompt(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.source?.kind === "user")
    .map((message) => toText(message.content))
    .filter(Boolean)
    .join("\n\n");
}

function enqueue(pending, session, operation, log) {
  const previous = pending.get(session) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(operation)
    .catch((error) => {
      log.warn(`[everme] save degraded open: ${safeError(error)}`);
    });
  pending.set(session, current);
  return current;
}

function createLogger(ctx, override) {
  if (override) return override;
  return {
    info(line) {
      ctx?.logger?.info?.(line);
    },
    warn(line) {
      ctx?.logger?.warn?.(line);
    },
  };
}

function safeError(error) {
  const text = redactError(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}
