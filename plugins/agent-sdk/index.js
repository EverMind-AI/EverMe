/**
 * @everme/agent-sdk — shared core for EverMe AI-agent plugins.
 *
 * This package is host-agnostic. It speaks the EverMe gateway's wire
 * protocol (/api/v1/mem/*) and exposes the high-level operations every
 * plugin host needs:
 *
 *   - createClient(cfg)       HTTP client (+ redactError, EvermeError)
 *   - searchMemory(...)       /mem/search
 *   - getContext(...)         /mem/context
 *   - saveAgentMemory(...)    /mem/agent-memory real-time write
 *   - savePersonalMemory(...) /mem/personal real-time profile write
 *   - resolveConfig(host)     env + host-config merge
 *   - constants               TIMEOUT_MS, UPLOAD_TIMEOUT_MS
 *   - prompt helpers          buildMemoryPrompt, formatRow
 *   - message helpers         toText, isSessionResetPrompt
 *
 * Everything host-specific (MCP server / OpenClaw ContextEngine /
 * Claude Code hooks / Cursor plugin / …) lives in its own
 * `@everme/<host>` package and depends on this SDK.
 *
 * Removed in 0.3 (deliberate trim): createBuffer, uploadDocument,
 * buildDocumentKey. Runtime persistence is now strictly
 * /mem/agent-memory — no plugin host should be creating /mem/sources
 * directly. If a future host needs document upload, reintroduce a
 * dedicated module rather than reviving the multi-layer buffer.
 */

export { createClient, EvermeError, redactError, describeError, requestMeta } from "./src/client.js";
export {
  saveAgentMemory,
  flushAgentMemory,
  convertAgentMessage,
  AGENT_MEMORY_ROLES,
  AGENT_MEMORY_TOOL_CALL_TYPES,
  MAX_MESSAGES_PER_REQUEST,
} from "./src/agent-memory.js";
export { capRunes, MAX_CONTENT_RUNES } from "./src/truncate.js";
export { savePersonalMemory, convertPersonalMessage } from "./src/personal-memory.js";
export { searchMemory, getContext } from "./src/search.js";
export { resolveConfig, assertConfigUsable, TIMEOUT_MS, UPLOAD_TIMEOUT_MS } from "./src/config.js";
export { buildMemoryPrompt, MEMORY_TYPES, MEMORY_TYPE_LABELS } from "./src/prompt.js";
export { toText, stripChannelMetadata, isSessionResetPrompt } from "./src/messages.js";
export { resolveHookKnobs } from "./src/hooks/knobs.js";
export {
  boundedTimeoutMs,
  HOOK_SAFETY_MARGIN_MS,
  HOST_HOOK_TIMEOUT_S,
  hookBudgetMs,
  MIN_REQUEST_BUDGET_MS,
  startHookWatchdog,
} from "./src/hooks/deadline.js";
export { sanitizeRecallQuery, extractUserIntent, formatQueryStats, QUERY_MAX_CHARS } from "./src/hooks/query.js";
export { createSessionState, createTurnCounter } from "./src/hooks/state.js";
export { createToolEventBuffer } from "./src/hooks/toolbuffer.js";
export { runHook } from "./src/hooks/runtime.js";
export { runInject } from "./src/hooks/inject.js";
export { renderProfileBlock, profileItemCount } from "./src/hooks/session-start.js";
