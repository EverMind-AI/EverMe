import { appendFile, mkdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { capRunes } from "../truncate.js";
import { DEFAULT_STATE_DIR, sanitizeSessionId } from "./state.js";

const DEFAULT_MAX_BUFFER_BYTES = 2_000_000;

/**
 * Per-conversation tool-event spool. Hosts whose transcript omits tool
 * outputs (Cursor) buffer each postToolUse payload here from a separate
 * short-lived hook process, and the Stop hook drains the spool to attach
 * the calls to the turn it uploads.
 *
 * Drain removes the file unconditionally: leaving events behind on a
 * failed upload would attach them to the NEXT turn of the conversation,
 * which is worse than losing them. Spools for turns whose Stop never
 * fired are pruned by the shared stale-state sweep.
 */
export function createToolEventBuffer({ stateDir = DEFAULT_STATE_DIR, maxBytes = DEFAULT_MAX_BUFFER_BYTES } = {}) {
  const fileFor = (sessionId) => path.join(stateDir, `${sanitizeSessionId(sessionId)}.toolbuf.jsonl`);
  return {
    async append(sessionId, event) {
      const file = fileFor(sessionId);
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      try {
        if ((await stat(file)).size >= maxBytes) return { dropped: true };
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const line = JSON.stringify({
        ts: Date.now(),
        generationId: textField(event?.generationId),
        id: textField(event?.id),
        name: textField(event?.name) || "unknown",
        input: capField(event?.input),
        output: capField(event?.output),
      });
      await appendFile(file, `${line}\n`, { encoding: "utf8", mode: 0o600 });
      return { dropped: false };
    },

    async drain(sessionId, { generationId = "" } = {}) {
      const file = fileFor(sessionId);
      let raw;
      try {
        raw = await readFile(file, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
      }
      await unlink(file).catch(() => {});
      const events = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        // Events stamped with a different generation belong to an earlier
        // aborted turn; unstamped events are kept (lenient by design —
        // Cursor's payload docs do not promise generation_id everywhere).
        if (generationId && event?.generationId && event.generationId !== generationId) continue;
        events.push(event);
      }
      return events;
    },
  };
}

function textField(value) {
  return typeof value === "string" ? value : "";
}

function capField(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return capRunes(value);
  try {
    return capRunes(JSON.stringify(value));
  } catch {
    return "";
  }
}
