import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { readCodexStoreBatches } from "./store-batches.js";
import { readLastTurn } from "./transcript.js";

// build-marketplace.mjs bundles this file into everme/bin/hook.mjs, which
// moves import.meta.url away from this source tree — a plain createRequire
// read of "../package.json" would then miss. __EVERME_CODEX_VERSION__ is
// the build-time constant that build script injects for that bundled
// path (see build-marketplace.mjs); typeof-checking it (rather than
// referencing it directly) keeps the unbundled path — tests, a direct
// `npm install` of this package — working via createRequire, since an
// undeclared identifier only throws when referenced without typeof.
const PKG_VERSION =
  typeof __EVERME_CODEX_VERSION__ === "string"
    ? __EVERME_CODEX_VERSION__
    : createRequire(import.meta.url)("../package.json").version;

const CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);

export const codexAdapter = {
  platform: "codex",
  version: PKG_VERSION,
  // One hook invocation is one logical turn and the delivery marker runs on
  // every one of them, so the SDK claims channel="hook" for these writes and
  // they enter L1-2's denominator. Whole-session hosts leave this unset.
  turnBoundary: "stop",
  taskBatching: true,
  // This host ships the mem_skill tool alongside the hook, so an injected
  // skill id is resolvable. Hosts without it must leave this unset: an id
  // the model cannot redeem is pure noise.
  skillFetch: true,

  envFile() {
    return process.env.EVERME_ENV_FILE_PATH || path.join(os.homedir(), ".codex", "everme.env");
  },

  normalizeInput(rawInput) {
    return {
      // No session_id → empty (writes are skipped downstream), like
      // cursor/devin: a constant fallback would merge unrelated sessions
      // into one conversation on the backend.
      sessionId: rawInput?.session_id || "",
      transcriptPath: rawInput?.transcript_path || "",
      cwd: rawInput?.cwd || "",
      prompt: rawInput?.prompt || "",
      turnId: rawInput?.turn_id || "",
      source: rawInput?.source || "",
    };
  },

  readLastTurn(input) {
    return readLastTurn(input?.transcriptPath, { diagnostic: (line) => console.error(line) });
  },

  readStoreBatches(input, options) {
    return readCodexStoreBatches(input, { ...options, diagnostic: (line) => console.error(line) });
  },

  formatOutput(event, { block = "" } = {}) {
    if (!CONTEXT_EVENTS.has(event) || !block) return {};
    return {
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: block,
      },
    };
  },
};
