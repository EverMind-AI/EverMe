/**
 * EverMe operations for the OpenCode / Kilo Code plugin, over
 * @everme/agent-sdk.
 *
 * runHook() is not used: it is built for a short-lived hook process and arms a
 * watchdog that calls process.exit(0). This code runs inside the long-lived
 * host process, so it uses the SDK primitives directly and owns its deadlines
 * (the same reasoning as @everme/pi).
 */

import { createRequire } from "node:module";

import {
  createClient,
  getContext,
  redactError,
  resolveConfig,
  runInject,
  saveAgentMemory,
  searchMemory,
  profileTag,
} from "@everme/agent-sdk";

const PKG_VERSION = createRequire(import.meta.url)("../package.json").version;

// Recall and profile decorate the user's turn and must never make a prompt
// feel stuck; saves run after the answer is shown, so they can wait longer.
export const RECALL_TIMEOUT_MS = 6000;
export const PROFILE_TIMEOUT_MS = 8000;
export const SAVE_TIMEOUT_MS = 20000;

const noopLog = { info() {}, warn() {} };

export function buildClient(credentials, log = noopLog) {
  const config = resolveConfig({
    ...(credentials.apiBase ? { apiBase: credentials.apiBase } : {}),
    agentId: credentials.agentId,
    agentToken: credentials.agentToken,
    ...(credentials.memoryHome ? { memoryHome: credentials.memoryHome } : {}),
    brand: credentials.brand,
    clientKind: "hook",
    clientVersion: PKG_VERSION,
  });
  return { client: createClient(config, log), config };
}

/**
 * Race an operation against a deadline. A deadline is tagged `timeout`
 * because, for a write, it means "we stopped waiting", not "the write failed":
 * the gateway stores the messages before it answers.
 */
export async function withDeadline(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`${label} exceeded ${ms}ms`);
          err.type = "timeout";
          reject(err);
        }, ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchProfileBlock(credentials, log = noopLog) {
  const { client } = buildClient(credentials, log);
  const { context } = await withDeadline(getContext(client, "", {}, log), PROFILE_TIMEOUT_MS, "mem/context");
  if (typeof context === "string" && context.trim()) {
    const text = context.trim();
    const tag = profileTag(credentials.brand);
    return text.startsWith(`<${tag}>`) ? text : `<${tag}>\n${text}\n</${tag}>`;
  }
  return "";
}

export async function fetchRecallBlock(credentials, prompt, log = noopLog) {
  const { client, config } = buildClient(credentials, log);
  const { block } = await withDeadline(
    runInject({ input: { prompt }, client, config, search: searchMemory, log }),
    RECALL_TIMEOUT_MS,
    "mem/search",
  );
  return block || "";
}

export async function uploadTurns(credentials, payload, { timeoutMs = SAVE_TIMEOUT_MS, log = noopLog } = {}) {
  const { client } = buildClient(credentials, log);
  return withDeadline(
    saveAgentMemory(client, { ...payload, flush: false, channel: "hook", taskBatching: true }, log),
    timeoutMs,
    "mem/agent-memory",
  );
}

export function describeFailure(error) {
  return redactError(error).replace(/\s+/g, " ").trim();
}
