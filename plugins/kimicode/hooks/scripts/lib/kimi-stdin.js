/**
 * Kimi Code hook stdin reader.
 *
 * Kimi Code feeds each hook a single JSON object on stdin using
 * snake_case keys. Base shape:
 *   { hook_event_name, session_id, cwd }
 * plus per-event fields:
 *   UserPromptSubmit -> prompt
 *   Stop             -> stop_hook_active   (NOTE: no transcript path)
 *   SessionStart     -> source
 *   SessionEnd       -> (base only)
 *
 * Returns {} on empty / malformed stdin so callers can treat a missing
 * payload the same as an empty one and exit 0 silently.
 */
export async function readStdinJSON() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
