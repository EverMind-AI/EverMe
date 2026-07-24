import { redactError } from "../client.js";

/**
 * Transport-independent enqueue/flush primitive shared by host stores.
 * Keeping this tiny core separate avoids a module cycle between the dispatcher
 * and the store implementations while remaining inside @everme/agent-sdk.
 */
export function createHookRuntime({ enqueue, flush, diagnostic = () => {}, rethrowOnError = false } = {}) {
  if (typeof enqueue !== "function") throw new TypeError("hook-runtime requires enqueue");
  if (typeof flush !== "function") throw new TypeError("hook-runtime requires flush");

  async function safe(label, operation) {
    try {
      return await operation();
    } catch (error) {
      try {
        diagnostic(`EverMe ${label} degraded: ${redactError(error)}`);
      } catch {
        // Diagnostics are best effort; never let a host hook fail closed.
      }
      if (rethrowOnError) throw error;
      return undefined;
    }
  }

  return {
    enqueueTurn(turn) {
      return safe("turn enqueue", () => enqueue({ ...turn, flush: false }));
    },
    onStop(conversationId) {
      return safe("Stop flush", () => flush(conversationId));
    },
    onSessionEnd(conversationId) {
      return safe("SessionEnd flush", () => flush(conversationId));
    },
    flushSession(turn) {
      return safe("session flush", () => enqueue({ ...turn, flush: true }));
    },
    flush(conversationId) {
      return safe("boundary flush", () => flush(conversationId));
    },
  };
}
