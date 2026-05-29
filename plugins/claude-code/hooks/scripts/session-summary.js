#!/usr/bin/env node
/**
 * SessionEnd hook — no runtime persistence here.
 *
 * Claude Code runtime memory is written turn-by-turn by the Stop hook through
 * /mem/agent-memory. SessionEnd must not upload a markdown summary to
 * /mem/sources, otherwise long-lived sessions create document sources.
 *
 * Hook contract:
 *   stdin  = JSON { transcript_path, session_id, cwd, ... }
 *   stdout = empty (no UI surface needed)
 */

process.on("uncaughtException", () => process.exit(0));
process.on("unhandledRejection", () => process.exit(0));

import { debug } from "./lib/redact.js";

async function main() {
  debug("summary", "skip: runtime persistence is handled by Stop via /mem/agent-memory");
  process.exit(0);
}

main();
