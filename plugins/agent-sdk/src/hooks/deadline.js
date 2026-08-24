/**
 * Hook time budget.
 *
 * A native hook runs as a short-lived process the host kills at the
 * timeout declared in its manifest. Until this module existed the SDK's
 * own request timeout was 30s and Claude Code's Stop timeout was also
 * 30s, so the abort path could never win: the process was killed
 * mid-request, the turn counter never committed, no diagnostic reached
 * stderr, and the turn was lost for good — the next Stop reads only the
 * new last turn, and nothing retries the old one.
 *
 * Two numbers meaning the same thing lived in two files and drifted.
 * They live here now, and the host manifests are asserted against this
 * table in tests.
 */

/**
 * Per-event host kill deadline in seconds, as declared in the manifests
 * we own (claude-code/hooks/hooks.json, kimicode/kimi.plugin.json — both
 * asserted against this table in tests). Hosts whose timeout we do not
 * declare (Codex, Cursor, Devin) inherit these values as a conservative
 * default: budgeting less time than the host allows costs a retry at
 * worst, budgeting more is the bug this module exists to fix.
 */
export const HOST_HOOK_TIMEOUT_S = Object.freeze({
  SessionStart: 30,
  UserPromptSubmit: 10,
  Stop: 30,
  SessionEnd: 30,
  PreCompact: 30,
});

/**
 * Headroom the hook keeps for itself: node startup, reading the
 * transcript, committing the turn counter, and writing a diagnostic. The
 * whole point is that we finish and report rather than get killed.
 */
export const HOOK_SAFETY_MARGIN_MS = 3_000;

/**
 * Floor for a single request. Handing fetch a zero or negative timeout
 * aborts it instantly and reports a timeout we caused ourselves; better
 * to make one honest attempt with what little is left.
 */
export const MIN_REQUEST_BUDGET_MS = 1_000;

/**
 * Milliseconds this hook process may spend before the host kills it, or
 * null for an event with no declared host timeout (no budget is better
 * than an invented one).
 */
export function hookBudgetMs(event) {
  const seconds = HOST_HOOK_TIMEOUT_S[event];
  if (!seconds) return null;
  return seconds * 1_000 - HOOK_SAFETY_MARGIN_MS;
}

/**
 * Clamp a request timeout to what is left before deadlineAt. Sequential
 * requests in one hook therefore share a single budget: a flush turn
 * sends enqueue then flush, and the second gets what the first left over
 * instead of a fresh full timeout.
 */
export function boundedTimeoutMs(configuredMs, deadlineAt, now = Date.now()) {
  if (!deadlineAt) return configuredMs;
  const remaining = deadlineAt - now;
  if (remaining < MIN_REQUEST_BUDGET_MS) return MIN_REQUEST_BUDGET_MS;
  return Math.min(configuredMs, remaining);
}

/**
 * Arm a timer that reports the hook ran out of time. It is the backstop
 * for a hook wedged past its own abort path — never a competitor to it —
 * so it fires AFTER the request deadline (requests abort themselves at
 * budgetMs, and even a last-gasp request granted past the deadline gets
 * only MIN_REQUEST_BUDGET_MS more) and before the host kill at
 * budgetMs + HOOK_SAFETY_MARGIN_MS, so a truly stuck hook still leaves a
 * line behind rather than dying silently — the symptom that made this
 * bug invisible. Firing earlier would kill a request that was about to
 * finish and preempt the fail-open handling that commits the turn
 * counter and writes the diagnostic.
 *
 * Returns a stop() to disarm it; the timers are injectable so the
 * behaviour is testable without waiting on wall-clock time.
 */
export function startHookWatchdog({
  event = "",
  budgetMs,
  onExpire,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!budgetMs || budgetMs <= 0) return () => {};
  const fireAt = budgetMs + HOOK_SAFETY_MARGIN_MS / 2;
  const handle = setTimer(() => {
    onExpire?.(
      `EverMe ${event || "hook"} hook gave up after ${fireAt}ms to stay inside the host timeout`,
    );
  }, fireAt);
  // A hook process must not be held open by its own watchdog.
  handle?.unref?.();
  return () => clearTimer(handle);
}
