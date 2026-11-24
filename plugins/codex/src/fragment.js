import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const ROLLOUT = new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${UUID})(?:_(${UUID}))?\\.jsonl$`);

export async function readFragmentScope(transcriptPath) {
  const stream = createReadStream(transcriptPath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event?.type !== "session_meta") continue;
      if (event.payload?.history_mode !== "paginated") return "";
      const match = path.basename(transcriptPath).match(ROLLOUT);
      if (!match) {
        if (event.payload?.history_base?.thread_id) {
          throw new Error("codex paginated fragment has no native rollout filename identity");
        }
        return "";
      }
      return `codex-fragment-${match[2] || match[1]}`;
    }
    return "";
  } finally {
    lines.close();
    stream.destroy();
  }
}
