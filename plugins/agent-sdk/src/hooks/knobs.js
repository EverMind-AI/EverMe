export function resolveHookKnobs(env = process.env) {
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
    injectTopK: strictInteger(env.EVERME_INJECT_TOPK, 10, 1, 20),
    injectProfile: strictBoolean(env.EVERME_INJECT_PROFILE, false),
    injectMinScore: strictFloat(env.EVERME_INJECT_MIN_SCORE, 0.1, 0, 1),
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
