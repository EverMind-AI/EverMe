/**
 * Thin wrapper around `@everme/agent-sdk` for the Claude Code hooks.
 *
 * Why this file still exists:
 *   - The hooks call `searchMemories(query, { topK })` / `getContext` /
 *     `saveAgentMemory` against an SDK-managed client created from our config.
 *     Centralising the client construction here keeps each hook script short.
 *   - Re-exports keep the rest of the codebase (and tests) stable —
 *     a future SDK rename would only land here.
 */

import {
  createClient,
  searchMemory as sdkSearchMemory,
  saveAgentMemory as sdkSaveAgentMemory,
  EvermeError,
} from "@everme/agent-sdk";
import { getConfig } from "./config.js";

let _client = null;

function getClient() {
  if (_client) return _client;
  _client = createClient(getConfig());
  return _client;
}

export async function searchMemories(query, opts = {}) {
  // agent is bound from the MemAuth token; no agentId in the body.
  return sdkSearchMemory(getClient(), { query, ...opts });
}

/**
 * Direct POST /mem/context that returns the gateway's raw shape
 * {profile, cachedAt, generatedAt}. The hooks render `profile`
 * themselves (see inject-memories.js / session-start.js's
 * renderProfileBlock). The SDK's `getContext` is too opinionated for
 * our needs (it extracts a server-rendered .context string the
 * gateway doesn't currently produce), so we bypass it and call the
 * client directly.
 *
 * Body is `{ forceRefresh: bool }` only — the agent is bound from
 * the MemAuth token, so `query`/`topK` are no longer forwarded.
 */
export async function getContext(_query, opts = {}) {
  const body = opts.forceRefresh ? { forceRefresh: true } : {};
  return getClient().request("POST", "/mem/context", body);
}

export async function saveAgentMemory(req, log) {
  return sdkSaveAgentMemory(getClient(), req, log);
}

export { EvermeError };
