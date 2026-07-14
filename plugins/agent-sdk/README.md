# @everme/agent-sdk

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
  createClient, EvermeError, redactError, REQUEST_SEMANTICS,
  // Agent-memory realtime writes
  saveAgentMemory, AGENT_MEMORY_ROLES, AGENT_MEMORY_TOOL_CALL_TYPES,
  // Search / context
  searchMemory, getContext,
  // Config (env + host-config merge)
  resolveConfig, assertConfigUsable, TIMEOUT_MS, UPLOAD_TIMEOUT_MS,
  // Prompt helpers
  buildMemoryPrompt, MEMORY_TYPES, MEMORY_TYPE_LABELS,
  // Message helpers
  toText, stripChannelMetadata, isSessionResetPrompt,
} from "@everme/agent-sdk";
```

## Wire contract

```
POST /api/v1/mem/search            → {items, total, queryTimeMs}
POST /api/v1/mem/context           → {profile, cachedAt, generatedAt}  // body: { forceRefresh?: bool }
POST /api/v1/mem/agent-memory      → {status, messageCount, flushed}
```

Auth: `Authorization: Bearer <emk_*|evt_*>`.

The envelope every endpoint follows:

```js
{ error, requestId, status, result }   // status === 0 → success, return result
```

## Concurrency / safety contracts

- **Request semantics**: GET/HEAD default to `safe_read`. The POST read endpoints `/mem/search` and `/mem/context` opt in explicitly through `REQUEST_SEMANTICS.SAFE_READ`. All other requests are `non_idempotent_write`; a caller cannot make a write retry merely by mislabelling it.
- **Retry**: safe reads make at most two attempts for transient transport failures, HTTP 429, and HTTP 5xx. Both attempts and any `Retry-After` delay share the original timeout budget. A timeout that consumes that budget is surfaced after one attempt rather than starting another full timeout.
- **Write safety**: POST writes such as `/mem/agent-memory` are attempted exactly once. A lost response can hide a server-side success, so blind retry can duplicate memory until every write path has a supported idempotency key.
- **Structured failures**: `EvermeError` includes `classification`, `causeCode`, `httpStatus`, `requestId`, `attempts`, `retryable`, and `elapsedMs`. These fields never include the request URL, query, body, token, or the native fetch cause message.
- **Redaction**: `redactError` scrubs `evt_*`, `emk_*`, `X-Amz-Signature/Credential/Security-Token`, and AWS access key ids. Apply at every error sink before passing to host stderr / model context.
- **Timeouts**: `EvermeError{type:"timeout", classification:"timeout"}` is thrown so callers can branch on it (e.g. degrade to fallback). Body-read timeouts are caught too — a stuck body no longer silently parses as `null`.

The public CLI/MCP/token redaction contract is documented in
[`../../docs/contracts.md`](../../docs/contracts.md).

## Tests

```
npm test
```

Covers HTTP envelope, safe-read retry gating, write single-attempt safety,
structured error metadata, config precedence, message normalization, and
agent-memory shaping.

## License

Apache-2.0
