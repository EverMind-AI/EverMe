import { createUserMessage } from "@deepseek-ai/dsh-llm";
import {
  assertConfigUsable,
  createClient,
  redactError,
  resolveConfig,
  runInject,
  saveAgentMemory,
  toText,
} from "@everme/agent-sdk";

export const name = "everme";
export const inject = ["agents"];

export function apply(ctx, config = {}) {
  installEverMeHooks(ctx, config);
}

export function installEverMeHooks(ctx, config = {}, dependencies = {}) {
  const log = createLogger(ctx, dependencies.log);
  const resolved = dependencies.config || resolveConfig(config);
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
              kind: "plugin",
              plugin: name,
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
    const messages = collectTurnMessages(session, event.data?.turn, event.seq);
    if (!messages.length) return;
    enqueue(pending, session, async () => {
      await save(client, {
        conversationId: String(session.id),
        messages,
        flush: true,
      }, log);
    }, log);
  });

  ctx.on("session/flush", async (session) => {
    await (pending.get(session) || Promise.resolve());
  });

  return { enabled: true, pending };
}

export function collectTurnMessages(session, turn, endSeq = Number.POSITIVE_INFINITY) {
  if (!session || !Number.isSafeInteger(turn) || !Array.isArray(session.events)) return [];
  const events = session.events;
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
  if (startIndex < 0) return [];

  const messages = [];
  for (const event of events.slice(startIndex + 1, endIndex)) {
    const converted = convertSessionEvent(event);
    if (converted) messages.push(converted);
  }
  return messages;
}

function convertSessionEvent(event) {
  if (event?.type === "user/message") {
    const message = event.data;
    if (message?.source?.kind !== "user") return null;
    const content = toText(message.content);
    return content ? { role: "user", content, timestamp: event.time } : null;
  }

  if (event?.type === "assistant/message") {
    const content = normalizeAssistantContent(event.data?.message?.content);
    return content.length ? { role: "assistant", content, timestamp: event.time } : null;
  }

  if (event?.type === "tool/result") {
    const block = event.data?.message?.content?.find((item) => item?.type === "tool-result");
    if (!block?.toolCallId) return null;
    return {
      role: "tool",
      toolCallId: String(block.toolCallId),
      content: block.content || [],
      timestamp: event.time,
    };
  }

  return null;
}

function normalizeAssistantContent(content) {
  const normalized = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === "text" && block.text) {
      normalized.push({ type: "text", text: block.text });
    } else if (block?.type === "tool-call" && block.id) {
      normalized.push({
        type: "toolCall",
        id: String(block.id),
        name: block.name || "unknown",
        arguments: block.arguments || "{}",
      });
    }
  }
  return normalized;
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
  return redactError(error instanceof Error ? error.message : String(error));
}
