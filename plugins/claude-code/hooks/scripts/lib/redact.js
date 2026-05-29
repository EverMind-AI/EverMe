/**
 * Re-exports the SDK's redactError so hook scripts have a single
 * import target. `debug` is plugin-local because it formats output
 * with the [everme:<prefix>] tag specific to Claude Code stderr.
 */

import { redactError } from "@everme/agent-sdk";

export { redactError };

const DEBUG = process.env.EVERME_DEBUG === "1";

/**
 * Synchronous stderr trace, gated on EVERME_DEBUG=1. Earlier revisions
 * dynamic-imported `redactError` here to "guard against tests mocking
 * the SDK at module-load time" — but the static export above already
 * load-fails in that scenario, AND the dynamic import is async, so
 * any line written after `process.exit(0)` was silently dropped. Using
 * the static `redactError` makes debug logging actually appear.
 */
export function debug(prefix, ...args) {
  if (!DEBUG) return;
  try {
    process.stderr.write(
      `[everme:${prefix}] ` +
        args
          .map((a) => (typeof a === "string" ? a : safeStringify(a)))
          .map(redactError)
          .join(" ") +
        "\n",
    );
  } catch {
    /* never throw from debug */
  }
}

function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
