/**
 * Client telemetry — POST /mem/import-events.
 *
 * Two properties are contractual, not preferences:
 *
 *  - Silent. A telemetry failure never reaches the host and never changes a
 *    hook's exit path. Measuring delivery must not become a way to lose a
 *    turn.
 *  - Bounded, and inside the hook's own deadline. The report is awaited (a
 *    detached promise dies with the process), but it is skipped outright
 *    when too little of the host budget is left — the turn being reported
 *    on matters more than the report.
 *
 * The gateway derives the platform label from the authenticated agent row,
 * so no event here carries one. Each event owns a closed field set that the
 * server rejects violations of (turn_delivery has no hookEvent,
 * hook_degraded has no outcome), which is why these are constructors rather
 * than a free-form object the caller fills in.
 */

import { requestMeta } from "../client.js";

export const TELEMETRY_PATH = "/mem/import-events";
export const TELEMETRY_TIMEOUT_MS = 2_000;

/**
 * Remaining host budget below which an event is dropped instead of sent.
 * Sits above the client's own MIN_REQUEST_BUDGET_MS floor so the clamp in
 * boundedTimeoutMs can never hand a request more time than the hook has.
 */
export const MIN_TELEMETRY_BUDGET_MS = 1_500;

export function turnDeliveryEvent({ outcome, code = "" }) {
  return { event: "turn_delivery", channel: "hooks", outcome, ...(code ? { code } : {}) };
}

export function hookDegradedEvent({ hookEvent, code = "" }) {
  return { event: "hook_degraded", channel: "hooks", hookEvent, ...(code ? { code } : {}) };
}

/**
 * Error code for hook_degraded: the backend errno when we have one, else the
 * transport class. Never the message — that is what the stderr diagnostic
 * and the server-side log line are for.
 */
export function degradedCode(error) {
  if (error?.name === "EvermeError") {
    return String(error.code || error.type || "upstream").slice(0, 64);
  }
  return String(error?.code || error?.name || "error").slice(0, 64);
}

export function telemetryTimeoutMs(deadlineAt, now = Date.now()) {
  if (!deadlineAt) return TELEMETRY_TIMEOUT_MS;
  const remaining = deadlineAt - now;
  if (remaining < MIN_TELEMETRY_BUDGET_MS) return 0;
  return Math.min(TELEMETRY_TIMEOUT_MS, remaining);
}

export function createTelemetry({ client, config = {}, now = Date.now } = {}) {
  const enabled = Boolean(client) && config.telemetry !== false;
  return {
    enabled,
    async report(event) {
      if (!enabled || !event) return false;
      const timeoutMs = telemetryTimeoutMs(config.deadlineAt, now());
      if (!timeoutMs) return false;
      try {
        await requestMeta(client, "POST", TELEMETRY_PATH, { ...event, ts: now() }, { timeoutMs });
        return true;
      } catch {
        return false;
      }
    },
  };
}
