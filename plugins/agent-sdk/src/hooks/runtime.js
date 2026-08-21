/**
 * Shared native-hook lifecycle runtime.
 *
 * The runtime lives inside @everme/agent-sdk so every host adapter consumes
 * one published protocol package. It owns enqueue/flush boundaries, host
 * event dispatch, env-file loading, auth gating, and fail-open diagnostics.
 */

import { readFile } from "node:fs/promises";
import { createClient, describeError, redactError } from "../client.js";
import { resolveConfig } from "../config.js";
import { resolveHookKnobs } from "./knobs.js";
import { hookBudgetMs, startHookWatchdog } from "./deadline.js";
import { createSessionState, createTurnCounter } from "./state.js";
import { runInject } from "./inject.js";
import { runSessionStart } from "./session-start.js";
import { runBoundaryFlush, runStore } from "./store.js";
export { createHookRuntime } from "./runtime-core.js";

const WRITE_EVENTS = new Set(["Stop", "SessionEnd", "PreCompact", "PostToolUse"]);
const ROTATED_KEYS = new Set(["EVERME_AGENT_TOKEN", "EVERME_AGENT_ID"]);

export async function runHook(event, rawInput, adapter, deps = {}) {
  // Process-level backstop: runHostHook already fails open on errors, but
  // nothing inside the process hears the host's SIGKILL. The watchdog
  // fires after the request deadline (so the abort and fail-open path get
  // to finish first) and before the host kill, leaving a line on stderr
  // so a hook that runs out of time is visible instead of just missing.
  const stopWatchdog = startHookWatchdog({
    event: adapter?.mapEvent?.(event) || event,
    budgetMs: hookBudgetMs(adapter?.mapEvent?.(event) || event),
    onExpire: (line) => {
      try {
        process.stderr.write(`${line}\n`);
      } catch {
        // A closed stderr must never break a hook.
      }
      process.exit(0);
    },
  });
  try {
    return await runHostHook(event, rawInput, adapter, {
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
  } finally {
    stopWatchdog();
  }
}

// Hooks own stdout (it is the host ABI), so HTTP-level lines — including the
// per-request requestId — go to stderr where hosts collect diagnostics.
const stderrLog = {
  info(line) {
    try {
      process.stderr.write(`${line}\n`);
    } catch {
      // A closed stderr must never break a hook.
    }
  },
  warn(line) {
    this.info(line);
  },
};

export async function runHostHook(event, rawInput, adapter, deps = {}) {
  const hostEvent = event;
  let result = { block: "", count: 0 };
  try {
    const canonicalEvent = adapter.mapEvent?.(hostEvent) || hostEvent;
    const input = await adapter.normalizeInput(rawInput || {}, hostEvent);
    const env = deps.env || await loadRuntimeEnv(adapter, deps.baseEnv || process.env);
    const baseConfig = deps.config || requireOperation(deps.resolveConfig, "resolveConfig")(env);
    if (!baseConfig.isConfigured) return formatOutput(adapter, hostEvent, result);
    if (WRITE_EVENTS.has(canonicalEvent) && (baseConfig.authMode !== "evt" || !baseConfig.agentId)) {
      return formatOutput(adapter, hostEvent, result);
    }

    // Every request this hook makes shares one deadline, set inside the
    // host's kill timeout. Without it the SDK's own 30s timeout equalled
    // (or, for UserPromptSubmit, tripled) the host's, so the host always
    // won the race and killed us mid-request with nothing written down.
    const budgetMs = deps.budgetMs === undefined ? hookBudgetMs(canonicalEvent) : deps.budgetMs;
    const config = budgetMs ? { ...baseConfig, deadlineAt: Date.now() + budgetMs } : baseConfig;

    const log = deps.log || stderrLog;
    const client = deps.client || requireOperation(deps.createClient, "createClient")(config, log);
    if (canonicalEvent === "SessionStart") {
      result = await requireOperation(deps.runSessionStart, "runSessionStart")({ input, client, config, log });
    } else if (canonicalEvent === "UserPromptSubmit") {
      result = await requireOperation(deps.runInject, "runInject")({ input, client, config, search: deps.searchMemory, log });
    } else if (canonicalEvent === "Stop") {
      const counter = deps.counter || requireOperation(deps.createTurnCounter, "createTurnCounter")({ stateDir: env.EVERME_STATE_DIR });
      result = await requireOperation(deps.runStore, "runStore")({
        input,
        adapter,
        client,
        config,
        counter,
        stateDir: env.EVERME_STATE_DIR,
        log,
        diagnostic: (line) => { throw new Error(line); },
      });
    } else if (canonicalEvent === "PostToolUse") {
      // Local spool only — hosts whose transcript omits tool outputs
      // (Cursor) buffer each call here and the Stop hook uploads them
      // with the turn. Adapters without the capability keep the old
      // no-op behavior for this event.
      if (typeof adapter.bufferToolUse === "function") {
        result = await adapter.bufferToolUse(input, { stateDir: env.EVERME_STATE_DIR });
      }
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
        log,
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
  // describeError appends errno + requestId for EvermeError — the line the
  // user quotes to support, so it must carry the correlation id.
  const redacted = error?.name === "EvermeError" ? describeError(error) : redact(error);
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
