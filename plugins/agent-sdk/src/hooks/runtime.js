/**
 * Shared native-hook lifecycle runtime.
 *
 * The runtime lives inside @everme/agent-sdk so every host adapter consumes
 * one published protocol package. It owns enqueue/flush boundaries, host
 * event dispatch, env-file loading, auth gating, and fail-open diagnostics.
 */

import { readFile } from "node:fs/promises";
import { createClient, redactError } from "../client.js";
import { resolveConfig } from "../config.js";
import { resolveHookKnobs } from "./knobs.js";
import { createSessionState, createTurnCounter } from "./state.js";
import { runInject } from "./inject.js";
import { runSessionStart } from "./session-start.js";
import { runBoundaryFlush, runStore } from "./store.js";
export { createHookRuntime } from "./runtime-core.js";

const WRITE_EVENTS = new Set(["Stop", "SessionEnd", "PreCompact"]);
const ROTATED_KEYS = new Set(["EVERME_AGENT_TOKEN", "EVERME_AGENT_ID"]);

export async function runHook(event, rawInput, adapter, deps = {}) {
  return runHostHook(event, rawInput, adapter, {
    ...deps,
    resolveConfig: resolveRuntimeConfig,
    createClient,
    createTurnCounter,
    createSessionState,
    runSessionStart,
    runInject,
    runStore,
    runBoundaryFlush,
    redactError,
  });
}

export async function runHostHook(event, rawInput, adapter, deps = {}) {
  const hostEvent = event;
  let result = { block: "", count: 0 };
  try {
    const canonicalEvent = adapter.mapEvent?.(hostEvent) || hostEvent;
    const input = await adapter.normalizeInput(rawInput || {}, hostEvent);
    const env = deps.env || await loadRuntimeEnv(adapter, deps.baseEnv || process.env);
    const config = deps.config || requireOperation(deps.resolveConfig, "resolveConfig")(env);
    if (!config.isConfigured) return formatOutput(adapter, hostEvent, result);
    if (WRITE_EVENTS.has(canonicalEvent) && (config.authMode !== "evt" || !config.agentId)) {
      return formatOutput(adapter, hostEvent, result);
    }

    const client = deps.client || requireOperation(deps.createClient, "createClient")(config);
    if (canonicalEvent === "SessionStart") {
      result = await requireOperation(deps.runSessionStart, "runSessionStart")({ input, client, config });
    } else if (canonicalEvent === "UserPromptSubmit") {
      result = await requireOperation(deps.runInject, "runInject")({ input, client, config, search: deps.searchMemory, log: deps.log });
    } else if (canonicalEvent === "Stop") {
      const counter = deps.counter || requireOperation(deps.createTurnCounter, "createTurnCounter")({ stateDir: env.EVERME_STATE_DIR });
      result = await requireOperation(deps.runStore, "runStore")({
        input,
        adapter,
        client,
        config,
        counter,
        diagnostic: (line) => { throw new Error(line); },
      });
    } else if (canonicalEvent === "SessionEnd" || canonicalEvent === "PreCompact") {
      // Optional: without a session state store the boundary flush still
      // works, it just loses re-fire idempotency (no high-water mark).
      const sessionState = deps.sessionState
        || (typeof deps.createSessionState === "function"
          ? deps.createSessionState({ stateDir: env.EVERME_STATE_DIR })
          : undefined);
      result = await requireOperation(deps.runBoundaryFlush, "runBoundaryFlush")({
        input,
        adapter,
        client,
        sessionState,
        diagnostic: (line) => { throw new Error(line); },
      });
    }
    return formatOutput(adapter, hostEvent, result);
  } catch (error) {
    writeDiagnostic(hostEvent, error, deps.redactError || redactError, deps.writeStderr);
    return formatOutput(adapter, hostEvent, { block: "", count: 0, degraded: true });
  }
}

function resolveRuntimeConfig(env) {
  const agentToken = env.EVERME_AGENT_TOKEN || env.EVERME_API_KEY || "";
  const authMode = env.EVERME_AGENT_TOKEN ? "evt" : env.EVERME_API_KEY ? "emk" : "none";
  const knobs = resolveHookKnobs(env);
  return {
    ...resolveConfig({
      apiBase: env.EVERME_API_BASE,
      agentId: env.EVERME_AGENT_ID,
      agentToken,
      ...knobs,
    }),
    ...knobs,
    authMode,
    isConfigured: Boolean(agentToken),
  };
}

async function loadRuntimeEnv(adapter, baseEnv) {
  const merged = { ...baseEnv };
  const file = adapter.envFile?.();
  if (!file) return merged;

  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return merged;
    throw error;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals < 1) continue;
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (ROTATED_KEYS.has(key) || !merged[key]) merged[key] = value;
  }
  return merged;
}

function requireOperation(fn, name) {
  if (typeof fn !== "function") throw new TypeError(`hook-runtime requires ${name}`);
  return fn;
}

function writeDiagnostic(event, error, redact = redactError, writer = (line) => process.stderr.write(line)) {
  const redacted = redact(error);
  const reason = String(redacted).replace(/\s+/g, " ").trim();
  const label = {
    SessionStart: "start",
    UserPromptSubmit: "inject",
    Stop: "store",
    SessionEnd: "summary",
    PreCompact: "compact",
  }[event] || event;
  writer(`EverMe ${label} hook degraded: ${reason}\n`);
}

function formatOutput(adapter, event, result) {
  if (typeof adapter?.formatOutput !== "function") return {};
  return adapter.formatOutput(event, result) ?? {};
}
