/**
 * Shared native-hook lifecycle runtime.
 *
 * The runtime lives inside @everme/agent-sdk so every host adapter consumes
 * one published protocol package. It owns enqueue/flush boundaries, host
 * event dispatch, env-file loading, auth gating, and fail-open diagnostics.
 */

import { readFile } from "node:fs/promises";
import { createClient, describeError, redactError } from "../client.js";
import { resolveConfig, routeInjectMinScore } from "../config.js";
import { brandOf, brandStrings } from "../brand.js";
import { resolveHookKnobs } from "./knobs.js";
import { DETACHED_HOOK_BUDGET_MS, DETACHED_WRITE_TIMEOUT_MS, hookBudgetMs, startHookWatchdog } from "./deadline.js";
import {
  createSessionState,
  createTranscriptCheckpointStore,
  createTurnCounter,
} from "./state.js";
import { createTimestampLedger } from "../timestamps.js";
import { runInject } from "./inject.js";
import { runSessionStart } from "./session-start.js";
import { runBoundaryFlush, runStore } from "./store.js";
import { createTelemetry, degradedCode, hookDegradedEvent } from "./telemetry.js";
export { createHookRuntime } from "./runtime-core.js";

const WRITE_EVENTS = new Set(["Stop", "SubagentStop", "SessionEnd", "PreCompact", "PostToolUse"]);
const ROTATED_KEYS = new Set(["EVERME_AGENT_TOKEN", "EVERME_AGENT_ID"]);

/**
 * withClientIdentity attributes every native-hook request as
 * "hook/<plugin version>" (X-EverMe-Client). The platform is NOT sent: the
 * server derives it from the evt agent row. Pure so it is unit-testable —
 * runHook overrides the caller's createClient with the real one, so the
 * config it builds cannot be observed through deps injection.
 */
export function withClientIdentity(config, adapter) {
  return {
    ...config,
    clientKind: "hook",
    clientVersion: adapter?.version || "",
    // Normalised to a boolean here rather than trusted as written: an
    // adapter that declares the capability as a string would otherwise be
    // truthy everywhere downstream.
    skillFetch: adapter?.skillFetch === true,
  };
}

export async function runHook(event, rawInput, adapter, deps = {}) {
  // Process-level backstop: runHostHook already fails open on errors, but
  // nothing inside the process hears the host's SIGKILL. The watchdog
  // fires after the request deadline (so the abort and fail-open path get
  // to finish first) and before the host kill, leaving a line on stderr
  // so a hook that runs out of time is visible instead of just missing.
  //
  // `deps.detached` marks a worker the plugin spawned outside the host's
  // hook protocol: no host kill applies, so it takes the longer detached
  // budget instead of the host event's.
  const stopWatchdog = startHookWatchdog({
    event: adapter?.mapEvent?.(event) || event,
    budgetMs: deps.detached === true
      ? DETACHED_HOOK_BUDGET_MS
      : hookBudgetMs(adapter?.mapEvent?.(event) || event),
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
      createTranscriptCheckpointStore,
      createTimestampLedger,
      createTelemetry,
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

// Fallback timestamps must survive the process: a resend usually comes from
// a later hook or worker process. Without the factory (unit tests drive
// runHostHook directly) saveAgentMemory falls back to its process ledger.
function timestampLedgerFor(deps, env) {
  if (deps.timestampLedger) return deps.timestampLedger;
  if (typeof deps.createTimestampLedger !== "function") return undefined;
  return deps.createTimestampLedger({ stateDir: env.EVERME_STATE_DIR });
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
  // Hoisted so the fail-open catch can report the degradation it is about
  // to swallow. Both stay null until a configured client exists — a hook
  // that failed before that has no credential to report with.
  let telemetry = null;
  let degradedEvent = hostEvent;
  let brand = brandOf(deps.baseEnv || process.env);
  try {
    const canonicalEvent = adapter.mapEvent?.(hostEvent) || hostEvent;
    degradedEvent = canonicalEvent;
    const input = await adapter.normalizeInput(rawInput || {}, hostEvent);
    const env = deps.env || await loadRuntimeEnv(adapter, deps.baseEnv || process.env);
    brand = brandOf(env);
    // The skill body cache reads process.env, so it must see this brand's dir.
    if (env.EVERME_STATE_DIR) process.env.EVERME_STATE_DIR = env.EVERME_STATE_DIR;
    const baseConfig = deps.config || requireOperation(deps.resolveConfig, "resolveConfig")(env);
    if (!baseConfig.isConfigured) return formatOutput(adapter, hostEvent, result, brand);
    if (WRITE_EVENTS.has(canonicalEvent) && (baseConfig.authMode !== "evt" || !baseConfig.agentId)) {
      return formatOutput(adapter, hostEvent, result, brand);
    }

    // Every request this hook makes shares one deadline, set inside the
    // host's kill timeout. Without it the SDK's own 30s timeout equalled
    // (or, for UserPromptSubmit, tripled) the host's, so the host always
    // won the race and killed us mid-request with nothing written down.
    const detached = deps.detached === true;
    const budgetMs = deps.budgetMs !== undefined
      ? deps.budgetMs
      : (detached ? DETACHED_HOOK_BUDGET_MS : hookBudgetMs(canonicalEvent));
    const config = withClientIdentity(
      budgetMs ? { ...baseConfig, deadlineAt: Date.now() + budgetMs } : baseConfig,
      adapter,
    );
    // A host-bound hook keeps the client's request timeout, clamped to the
    // host deadline above. A detached worker may wait out a slow EverOS
    // write instead of giving up and resending into its session lock.
    const writeTimeoutMs = detached ? DETACHED_WRITE_TIMEOUT_MS : undefined;

    const log = deps.log || stderrLog;
    const client = deps.client || requireOperation(deps.createClient, "createClient")(config, log);
    telemetry = deps.telemetry
      || (typeof deps.createTelemetry === "function" ? deps.createTelemetry({ client, config }) : null);
    const storeAtEnd = canonicalEvent === "SessionEnd" && await noTurnStored(adapter, deps, env, input);
    if (canonicalEvent === "SessionStart") {
      result = await requireOperation(deps.runSessionStart, "runSessionStart")({ input, client, config, log });
    } else if (canonicalEvent === "UserPromptSubmit") {
      result = await requireOperation(deps.runInject, "runInject")({ input, client, config, search: deps.searchMemory, log });
    } else if (canonicalEvent === "Stop" || canonicalEvent === "SubagentStop" || storeAtEnd) {
      const counter = deps.counter || requireOperation(deps.createTurnCounter, "createTurnCounter")({ stateDir: env.EVERME_STATE_DIR });
      const checkpointStore = deps.checkpointStore
        || (typeof deps.createTranscriptCheckpointStore === "function"
          ? deps.createTranscriptCheckpointStore({ stateDir: env.EVERME_STATE_DIR })
          : undefined);
      // Optional, like the boundary-flush store: without it the turn still
      // uploads, it just carries no delivery marker (so no turn_delivery).
      const sessionState = deps.sessionState
        || (typeof deps.createSessionState === "function"
          ? deps.createSessionState({ stateDir: env.EVERME_STATE_DIR })
          : undefined);
      result = await requireOperation(deps.runStore, "runStore")({
        timestampLedger: timestampLedgerFor(deps, env),
        writeTimeoutMs,
        input,
        adapter,
        client,
        config,
        counter,
        checkpointStore,
        sessionState,
        stateDir: env.EVERME_STATE_DIR,
        log,
        diagnostic: (line) => { throw new Error(line); },
        telemetry,
      });
      // Record which event stored the turn: the next SessionEnd stores a
      // turn only while no Stop has (see noTurnStored).
      if (adapter?.storeAtSessionEndWithoutStop === true && sessionState && input?.sessionId && result?.count > 0) {
        await sessionState.patch(input.sessionId, { stopStored: !storeAtEnd });
      }
    } else if (canonicalEvent === "PostToolUse") {
      // Local spool only — hosts whose transcript omits tool outputs
      // (Cursor) buffer each call here and the Stop hook uploads them
      // with the turn. Adapters without the capability keep the old
      // no-op behavior for this event.
      if (typeof adapter.bufferToolUse === "function") {
        result = await adapter.bufferToolUse(input, { stateDir: env.EVERME_STATE_DIR });
      }
    }
    // A SessionEnd that stored the turn still ends the session: the stored
    // write does not flush, and a one-shot run has no later boundary.
    if (canonicalEvent === "SessionEnd" || canonicalEvent === "PreCompact") {
      // Optional: without a session state store the boundary flush still
      // works, it just loses re-fire idempotency (no high-water mark).
      const sessionState = deps.sessionState
        || (typeof deps.createSessionState === "function"
          ? deps.createSessionState({ stateDir: env.EVERME_STATE_DIR })
          : undefined);
      const checkpointStore = deps.checkpointStore
        || (typeof deps.createTranscriptCheckpointStore === "function"
          ? deps.createTranscriptCheckpointStore({ stateDir: env.EVERME_STATE_DIR })
          : undefined);
      result = await requireOperation(deps.runBoundaryFlush, "runBoundaryFlush")({
        timestampLedger: timestampLedgerFor(deps, env),
        writeTimeoutMs,
        input,
        adapter,
        client,
        sessionState,
        checkpointStore,
        stateDir: env.EVERME_STATE_DIR,
        log,
        diagnostic: (line) => { throw new Error(line); },
      });
    }
    return formatOutput(adapter, hostEvent, result, brand);
  } catch (error) {
    writeDiagnostic(hostEvent, error, deps.redactError || redactError, deps.writeStderr, brand);
    // The stderr line most hosts discard is the only other record of this,
    // which is what makes a broken host adapter invisible on the dashboard.
    try {
      await telemetry?.report(hookDegradedEvent({ hookEvent: degradedEvent, code: degradedCode(error) }));
    } catch {
      // Reporting a degradation must not itself degrade the hook.
    }
    return formatOutput(adapter, hostEvent, { block: "", count: 0, degraded: true }, brand);
  }
}

// A host whose one-shot mode fires no Stop (Cursor CLI's -p) asks for its
// SessionEnd to store the turn while no Stop stored one in that session. Each
// run of `cursor-agent -p --continue` ends with its own SessionEnd, so every
// run stores its turn there. A session where a Stop stored turns keeps the
// boundary flush, so its last turn is not sent twice. A state file written
// before stopStored existed falls back to the turn count.
async function noTurnStored(adapter, deps, env, input) {
  if (adapter?.storeAtSessionEndWithoutStop !== true || !input?.sessionId) return false;
  const sessionState = deps.sessionState
    || (typeof deps.createSessionState === "function"
      ? deps.createSessionState({ stateDir: env.EVERME_STATE_DIR })
      : undefined);
  if (!sessionState) return false;
  const state = await sessionState.read(input.sessionId);
  return typeof state?.stopStored === "boolean" ? !state.stopStored : !state?.count;
}

export function resolveRuntimeConfig(env) {
  const agentToken = env.EVERME_AGENT_TOKEN || env.EVERME_API_KEY || "";
  const authMode = env.EVERME_AGENT_TOKEN ? "evt" : env.EVERME_API_KEY ? "emk" : "none";
  const knobs = resolveHookKnobs(env, { injectMinScore: routeInjectMinScore(env) });
  return {
    ...resolveConfig({
      apiBase: env.EVERME_API_BASE,
      agentId: env.EVERME_AGENT_ID,
      agentToken,
      memoryHome: env.EVERME_MEMORY_HOME,
      brand: env.EVERME_BRAND,
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
  const fileEnv = {};
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
    fileEnv[key] = value;
  }
  // A file that names its brand (EverOS) owns every key it sets: an EverMe
  // variable exported in the host must not send EverOS's token to EverMe or
  // share EverMe's state. An EverMe file keeps the process overrides.
  const ownsAll = Boolean(fileEnv.EVERME_BRAND);
  for (const [key, value] of Object.entries(fileEnv)) {
    if (ownsAll || ROTATED_KEYS.has(key) || !merged[key]) merged[key] = value;
  }
  return merged;
}

function requireOperation(fn, name) {
  if (typeof fn !== "function") throw new TypeError(`hook-runtime requires ${name}`);
  return fn;
}

function writeDiagnostic(event, error, redact = redactError, writer = (line) => process.stderr.write(line), brand = "everme") {
  // describeError appends errno + requestId for EvermeError — the line the
  // user quotes to support, so it must carry the correlation id.
  const redacted = error?.name === "EvermeError" ? describeError(error) : redact(error);
  const reason = String(redacted).replace(/\s+/g, " ").trim();
  const label = {
    SessionStart: "start",
    UserPromptSubmit: "inject",
    Stop: "store",
    SubagentStop: "subagent-store",
    SessionEnd: "summary",
    PreCompact: "compact",
  }[event] || event;
  writer(`${brand === "everos" ? "EverOS" : "EverMe"} ${label} hook degraded: ${reason}\n`);
}

// The status line the host shows is the brand's; the injected block is the
// user's memory and is passed on as written.
function formatOutput(adapter, event, result, brand) {
  if (typeof adapter?.formatOutput !== "function") return {};
  const out = adapter.formatOutput(event, result) ?? {};
  if (typeof out.systemMessage === "string") out.systemMessage = brandStrings(out.systemMessage, brand);
  return out;
}
