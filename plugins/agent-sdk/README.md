# @everme/agent-sdk

The `createToolEventBuffer` tool spool preserves complete serialized input and
output fields, including empty strings; it does not apply the ordinary-message
8000-character budget. Its existing total file-size policy is unchanged. Hosts
must validate their native tool contract before appending events.

Shared core for every EverMe AI-agent plugin. **Host-agnostic** — talks to the EverMe gateway (`/api/v1/mem/*` + presign + S3 multipart) and nothing else. Per-host concerns (MCP framing, OpenClaw lifecycle, Claude Code hooks, …) live in their own packages and depend on this SDK.

## Why this exists

EverMe ships one plugin per AI-agent host so each can iterate independently:

| Package | Host | Format |
|---|---|---|
| `@everme/memory-mcp` | Cursor / Cline / generic MCP host | MCP server (stdio / JSON-RPC) |
| `@everme/openclaw` | OpenClaw | ContextEngine plugin (in-process module) |
| `@everme/claude-code` | Claude Code | Native plugin (hooks + commands + skills + MCP) |

Without a shared SDK each plugin would reimplement the EverMe wire protocol — duplicating redaction, search/context shaping, agent-memory writes, and the inevitable bugs in each. The SDK is the single source of truth for "how to talk to the EverMe gateway", and every host plugin is a thin adapter on top.

## Exports

```js
import {
  // HTTP layer
  createClient, EvermeError, redactError,
  // Agent-memory realtime writes
  saveAgentMemory, AGENT_MEMORY_ROLES, AGENT_MEMORY_TOOL_CALL_TYPES,
  // Search / context
  searchMemory, getContext,
  // Config (env + host-config merge)
  resolveConfig, assertConfigUsable, TIMEOUT_MS, UPLOAD_TIMEOUT_MS,
  // Prompt helpers
  buildMemoryPrompt, MEMORY_TYPES, MEMORY_TYPE_LABELS,
  // Message helpers
  extractText, toText, stripChannelMetadata, isSessionResetPrompt,
} from "@everme/agent-sdk";
```

## Wire contract

```
POST /api/v1/mem/search            → {items, profiles, rawMessages, agentMemory}
POST /api/v1/mem/context           → {profile, cachedAt, generatedAt}  // body: { forceRefresh?: bool }
POST /api/v1/mem/agent-memory      → {status, messageCount, flushed}
```

Auth: `Authorization: Bearer <emk_*|evt_*>`.

The envelope every endpoint follows:

```js
{ error, requestId, status, result }   // status === 0 → success, return result
```

Write sync contract: `/mem/agent-memory` accepts `flush` (synchronous add on
every batch + extraction flush) and `sync` (synchronous add only, no flush).
`saveAgentMemory` sets `sync: true` on the leading requests of a multi-request
upload whose flush rides the final request, so earlier batches keep the
synchronous-add guarantee. The hook runtime also sets `sync: true` on every
enqueue, so checkpoints and later cadence/boundary flushes follow a completed
add rather than merely an accepted asynchronous job. Direct SDK callers can
opt into this with `sync: true`; plain `flush: false` calls stay asynchronous.
This ordering guarantee requires a gateway supporting the existing `sync`
field; older servers that ignore it cannot provide the guarantee. `flushed` on
the result means the flush was issued — `status` / `extracted` are the
materialisation signals, and `status: "no_extraction"` means the upstream
queued the session without extracting yet.

Uploads above 500 messages are split in source order, preferring a completed
turn, then a complete tool-call/result group, then the hard message limit.
Tool result text is not capped to 8000 characters by the shared writer;
host-side parsing/redaction still applies. Ordinary user/assistant text and
personal-memory text retain their existing budgets. Server request-size limits
still apply, and a tool result must remain a single message, not several
same-ID result fragments.

User and assistant text keep literal protocol examples, metadata quotes, and timestamps;
the shared writer does not treat those strings as user-channel envelopes.
This applies to both agent-memory and personal-memory writes. Host adapters
remain responsible for excluding actual control records using their native
source structure. Existing whitespace normalization and text budgets remain.
`extractText` provides plain text extraction without envelope heuristics for
host write adapters. `toText` and `stripChannelMetadata` retain their existing
query-normalization behavior; they must not reclassify native conversation text.

An assistant message only closes a turn when followed by a user/new `turnId`,
or when the adapter supplies `turnComplete: true`, and no calls remain pending.
An explicit `turnComplete: false` marks commentary or execution records and
prevents those records from being used as turn endings.
Input exhaustion alone does not prove completion. `turnId` remains local.
An explicit boolean `turnComplete` on assistant messages is also sent to the
EverMe gateway so its byte-based batching can use the same source evidence.
The gateway consumes this optional field without forwarding it to EverOS.
Older clients omit it and keep their existing behavior; older gateways ignore
it and therefore do not gain this byte-boundary improvement. Forced splits
preserve actual messages without inventing missing results or endings.

Request id contract: `createClient` generates a UUID per request and sends it
as the `requestId` header; the gateway reuses a valid inbound value, so plugin
stderr, EverMe ELK, and the cloud platform's log search all join on one id.
`client.requestWithMeta(...)` resolves to `{ result, requestId }`; the wrapper
helpers (`searchMemory` / `getContext` / `saveAgentMemory` /
`savePersonalMemory`) surface the same id on their results, and `EvermeError`
carries it (`err.requestId`, rendered by `err.describe()` /
`describeError(err)`).

Tool-result content is converted to text with leading/trailing whitespace
trimmed, but channel metadata patterns are not removed: tool output can
contain literal protocol examples, log timestamps, or message IDs. The same
literal-content rule applies to user and assistant messages as described above.

## Adapter turn boundary

Adapters that write through `readStoreBatches` must say whether one hook
invocation is one logical turn:

```js
export const myAdapter = { platform: "my-host", turnBoundary: "stop", /* ... */ };
```

With `turnBoundary: "stop"` the SDK claims `channel: "hook"` on every batch of
a Stop and declares `turns: 1` on the last one (earlier batches carry `turns: 0`),
which is what puts the host's writes in the L1-2 capture-completeness
denominator. Leave it unset for whole-session hosts that upload at SessionEnd:
they run no per-turn delivery marker, cannot report lost turns, and must not
enter a denominator whose losses they can never reach. The simple
`readLastTurn` path always claims the channel; it is per-turn by construction.

## Env-file precedence

The shared hook runtime merges the host's `everme.env` file into the process env. File values never override variables already set in the shell — **except** `EVERME_AGENT_TOKEN` and `EVERME_AGENT_ID`, where the file wins. This asymmetry is deliberate: `evercli` rotates the per-machine evt token by rewriting `everme.env`, and a stale token exported in the shell must not shadow the rotated credential.

A file that sets `EVERME_BRAND` (an EverOS install writes it) overrides the shell for every key it sets. An EverMe variable exported in the shell cannot send the EverOS token to EverMe or share the EverMe state directory.

## Device route (local memory)

EverMe Desktop writes `~/.everme/memory/route.json` when the user turns on local memory (`$EVERME_MEMORY_HOME/route.json` when that is set). While it says `local`, `createClient` sends every request to its loopback gateway, whatever `apiBase` / `EVERME_API_BASE` say. The file is read per request, so long-lived hosts (OpenClaw, MCP servers) follow a switch without a restart. It fails closed: an unreadable, corrupt or off-machine route still means the default gateway (`http://127.0.0.1:18790`). A stopped gateway fails the request with a hint to open EverMe Desktop; the client never falls back to the cloud.

## Concurrency / safety contracts

- **Retry**: `execWithRetry` retries transport failures once — but only for GET/HEAD. POST writes (`/mem/agent-memory`) surface the transport error so the caller can decide; retrying a POST after a mid-flight drop can duplicate writes.
- **Redaction**: `redactError` scrubs `evt_*`, `emk_*`, `X-Amz-Signature/Credential/Security-Token`, and AWS access key ids. Apply at every error sink before passing to host stderr / model context.
- **Timeouts**: `EvermeError{type:"timeout"}` is thrown so callers can branch on it (e.g. degrade to fallback) rather than retrying as if it were a transport blip. Body-read timeouts are caught too — a stuck body no longer silently parses as `null`.

## Tests

```
npm test
```

Covers HTTP envelope, retry gating, config precedence, message normalization, agent-memory shaping.

## License

Apache-2.0

## Task-aware batching

`saveAgentMemory` accepts optional `syncScope` for native fragment progress.
Scoped writes check `/mem/agent-memory/state` before sending any batch: hook
writes require `hookSyncScopeSupported: true`, import writes require
`syncScopeSupported: true`. All batches retain the scope; older servers fail
without writing. Unscoped calls and separate session flushes keep their original
protocol. This field does not change the upstream conversation identity and
cannot be combined with `deduplication`.

`saveAgentMemory` also forwards optional `deduplication: "client-native-id"`
on every batch for hooks that own their re-send protection (for example
QwenWork, OpenClaw, Pi and ZeroClaw). It requires a supporting Server,
`channel: "hook"`, and no `offline`. A write can also carry `baseTurn` to
anchor the turn watermark. Server rejects other values and combinations. The
default stays positional. Native-ID selection is client-owned; Server bypasses positional
watermarks rather than storing per-message identities. It does not guarantee
cross-channel deduplication or exactly-once POST retries. Transcript checkpoint
`commit(stateId, uploadedCount, { nativeMessageIds })` persists optional local
identity keys only after successful upload; count-only callers are unchanged.

`saveAgentMemory` accepts optional `taskBatching: true`; hook adapters opt in
with the same property. Currently only Codex enables it. Other callers retain
the existing batching path. This is a local SDK option, never a wire field.

The strategy plans user tasks, preserves fitting original results, compresses
only byte-oversized tasks with 4/3/2 KiB UTF-8 tool-result budgets, then splits
remaining overflow with text/pair/hard-boundary priority. It uses a 64 KiB soft
target, 280 KiB message budget and 500-message cap. It preserves message count,
order and source metadata, so baseTurn/turns and final-batch flush behavior stay
on the existing upload path. Hard fallback is not a guarantee of closed tasks.
