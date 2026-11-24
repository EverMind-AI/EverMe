// Recall shaping knobs. The values are tuned, not arbitrary — the measurements
// behind them live in docs/plugin/research/recall-quality-spec.md ("problem 1").
// EVERME_INJECT_TOPK / EVERME_INJECT_MIN_SCORE override them per deployment.
// Only the tuned values are named; the lower bounds and the score's 0..1 range
// are the domain of the setting itself, not something we picked.
export const DEFAULT_INJECT_TOPK = 5;
export const MAX_INJECT_TOPK = 20;
export const DEFAULT_INJECT_MIN_SCORE = 0.3;

// defaults.injectMinScore replaces DEFAULT_INJECT_MIN_SCORE for a backend
// whose scores sit on another scale (the route file names it); an explicit
// EVERME_INJECT_MIN_SCORE still wins.
export function resolveHookKnobs(env = process.env, defaults = {}) {
  const flushMode = String(env.EVERME_FLUSH_MODE ?? "").trim().toLowerCase();
  const configuredFlushEveryTurns = strictInteger(
    env.EVERME_FLUSH_EVERY_TURNS,
    5,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  return {
    flushEveryTurns: flushMode === "legacy" ? 1 : configuredFlushEveryTurns,
    flushMode,
    injectTopK: strictInteger(env.EVERME_INJECT_TOPK, DEFAULT_INJECT_TOPK, 1, MAX_INJECT_TOPK),
    injectProfile: strictBoolean(env.EVERME_INJECT_PROFILE, false),
    injectMinScore: strictFloat(env.EVERME_INJECT_MIN_SCORE, defaults.injectMinScore ?? DEFAULT_INJECT_MIN_SCORE, 0, 1),
    telemetry: strictBoolean(env.EVERME_TELEMETRY, true),
  };
}

function strictInteger(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) return fallback;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function strictFloat(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const text = String(value).trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return fallback;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function strictBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false") return false;
  return fallback;
}
