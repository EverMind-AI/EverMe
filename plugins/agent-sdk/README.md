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

- **Retry**: `execWithRetry` retries transport failures once — but only for GET/HEAD. POST writes (`/mem/agent-memory`) surface the transport error so the caller can decide; retrying a POST after a mid-flight drop can duplicate writes.
- **Redaction**: `redactError` scrubs `evt_*`, `emk_*`, `X-Amz-Signature/Credential/Security-Token`, and AWS access key ids. Apply at every error sink before passing to host stderr / model context.
- **Timeouts**: `EvermeError{type:"timeout"}` is thrown so callers can branch on it (e.g. degrade to fallback) rather than retrying as if it were a transport blip. Body-read timeouts are caught too — a stuck body no longer silently parses as `null`.

The public CLI/MCP/token redaction contract is documented in
[`../../docs/contracts.md`](../../docs/contracts.md).

## Tests

```
npm test
```

Covers HTTP envelope, retry gating, config precedence, message normalization, agent-memory shaping.

## License

Apache-2.0
