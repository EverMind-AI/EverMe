/**
 * Opt-in content truncation for callers with a local text budget.
 * This is not an EverOS V2 per-message limit. Agent-memory tool results
 * bypass it to retain one complete result per call.
 */

export const MAX_CONTENT_RUNES = 8000;

const HEAD_RATIO = 0.7;

/**
 * Truncate text to at most `max` Unicode code points, keeping head + tail.
 * Counts and slices by code point (not UTF-16 code units) so multi-unit
 * characters are counted like the server and never split mid-surrogate.
 */
export function capRunes(text, max = MAX_CONTENT_RUNES) {
  const s = typeof text === "string" ? text : String(text ?? "");
  if (max <= 0) return s;
  // UTF-16 length is an upper bound on the code-point count, so a string
  // within `max` units is always within `max` code points — skip the
  // Array.from allocation for the common short-message case.
  if (s.length <= max) return s;
  const cps = Array.from(s); // code points
  if (cps.length <= max) return s;

  // Reserve marker space using the total length as an upper bound on the
  // trimmed count, so the real marker (fewer digits) is never longer than
  // budgeted — the result is therefore always <= max code points.
  const markerLen = `\n[... trimmed ${cps.length} chars by everme import ...]\n`.length;
  const budget = Math.max(0, max - markerLen);
  if (budget < 1) return cps.slice(0, max).join("");

  const head = Math.floor(budget * HEAD_RATIO);
  const tail = budget - head;
  const trimmed = cps.length - head - tail;
  const marker = `\n[... trimmed ${trimmed} chars by everme import ...]\n`;
  return cps.slice(0, head).join("") + marker + cps.slice(cps.length - tail).join("");
}
