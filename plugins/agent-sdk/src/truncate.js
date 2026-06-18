/**
 * Shared content truncation for the agent / personal memory write paths.
 *
 * The EverMe gateway rejects any message whose plain-text content exceeds
 * MAX_CONTENT_RUNES *code points* (rune count, not UTF-16 length). Clients
 * MUST truncate to fit so a long message is captured (lossy) rather than
 * hard-rejected (whole message/turn dropped — and the write path swallows
 * the error, so it would be a silent loss).
 *
 * Truncation keeps the HEAD and TAIL with a middle marker (head_ratio 0.7),
 * mirroring the server's case/skill extractor: it mines tool results and
 * final responses for findings that often live at the END of a long message
 * (final result, exit status, root-cause line), so the tail must survive.
 */

// The server's gate is rune-based (utf8.RuneCountInString > 8000 → reject),
// chosen to match the search-query rune limit. Keep this in sync.
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
