# EverMe Public Contracts

This document is the public contract for integration code that shells out to
`evercli` or talks to the EverMe MCP server. EverMe is optimized for AI agents,
so stdout, stderr, structured errors, MCP tools/resources, and token redaction
are part of the product surface.

Changing field names, removing fields, changing exit-code meaning, renaming MCP
tools/resources, or weakening redaction is a breaking change. Adding optional
fields, adding a new `error.type`, or redacting additional secret patterns is a
compatible change when existing callers continue to work.

## CLI Streams

`evercli` keeps stdout and stderr separate.

| Stream | Contract |
|---|---|
| stdout | Command results. In `json` and `yaml` formats this is the only machine-readable envelope. In `text` format this is human-facing business output only. |
| stderr | Logs, progress, prompts, warnings, hints, npm/host installer output, and fallback diagnostics. |

Agents should parse stdout and preserve stderr for diagnostics. New commands
must not write logs or progress to stdout.

`--format auto` resolves to:

| stdout target | Format |
|---|---|
| TTY | `text` |
| Pipe, redirect, test buffer, or CI | `json` |

Agents that need stable parsing should pass `--format json` explicitly.

## CLI Success Envelope

In `--format json` and `--format yaml` mode, successful commands write this
shape to stdout and exit `0`:

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "count": 0,
    "requestId": "req_x"
  }
}
```

`data` is command-specific. `meta` is optional and is used for out-of-band
fields such as `count` and `requestId`.

Text output is not a stable machine contract. It may change to improve human
readability.

## CLI Error Envelope

In `--format json` and `--format yaml` mode, failures write this shape to
stdout and exit non-zero:

```json
{
  "ok": false,
  "error": {
    "type": "invalid_args",
    "code": 0,
    "message": "invalid value for --format",
    "hint": "Use --format text|json|yaml",
    "detail": {
      "flag": "format"
    }
  },
  "meta": {
    "requestId": "req_x"
  }
}
```

In `text` mode, failures keep stdout empty and write a short message to stderr:

```text
error: Not logged in
hint: Run `evercli auth login` first
```

The `error.type` taxonomy is stable:

| Type | Meaning |
|---|---|
| `invalid_args` | Bad flag, argument, or user input. |
| `not_logged_in` | No local EverMe login/session is available. |
| `auth` | Token/key is invalid, expired, or revoked. |
| `network` | DNS, connection, TLS, timeout, or transport failure. |
| `upstream` | EverMe gateway returned a typed backend error. |
| `conflict` | Already exists, stale write, or idempotency conflict. |
| `not_found` | Requested resource does not exist. |
| `rate_limit` | Backend or transport throttling. |
| `permission` | Authenticated but not allowed. |
| `plugin_not_detected` | Host plugin/config could not be found. |
| `io` | Local filesystem or environment failure. |
| `cancelled` | Operation was interrupted or timed out by context. |
| `internal` | Unclassified CLI bug or unexpected local failure. |

`error.code` is reserved for upstream/backend numeric error codes. `hint` is
the next action an agent can show or attempt. `detail` is type-specific
structured data.

## CLI Exit Codes

Exit codes are intentionally coarse. Agents should use both the process exit
code and the structured `error.type`.

| Code | Meaning |
|---:|---|
| `0` | Success. |
| `1` | Business/API error such as `upstream`, `conflict`, `not_found`, `rate_limit`, `permission`, or `plugin_not_detected`. |
| `2` | Validation error, mapped from `invalid_args`. |
| `3` | Authentication error, mapped from `not_logged_in` or `auth`. |
| `4` | Network error. |
| `5` | Internal/local IO error. |
| `130` | Cancelled or interrupted operation. |

## MCP Stdio

The generic MCP server is `@everme/memory-mcp`. It speaks MCP JSON-RPC over
stdio. stdout is reserved for protocol frames. Runtime logs and boot failures
must go to stderr.

Boot failures are written to stderr and the process exits `1`. Tool-call
failures return MCP tool errors with `isError: true`; resource-read failures are
thrown as MCP JSON-RPC errors so hosts can distinguish them from successful
markdown content.

## MCP Tools

The stable tool names are:

| Tool | Required input | Return shape |
|---|---|---|
| `mem_context` | `query` string | Raw markdown text in `content[0].text`. |
| `mem_search` | `query` string | Raw markdown text in `content[0].text`. |
| `mem_save_turn` | `messages[]`, or legacy `role` plus `text`/`content` | JSON text in `content[0].text` with save status. |
| `mem_save_fact` | `fact`, or `messages[]` with only `user`/`assistant` roles | JSON text in `content[0].text` with save/extraction status. |

`mem_context` and `mem_search` deliberately return markdown directly, not a JSON
envelope. Hosts should splice the text into model context as-is.

`mem_search.topK` defaults to the configured topK or `5`, rejects non-positive
values by falling back to the default, and is capped at `50`.

`mem_save_turn` records conversation trajectories to `/mem/agent-memory`. Use
the `messages[]` form when preserving a tool round trip:

```json
{
  "messages": [
    { "role": "user", "content": "..." },
    {
      "role": "assistant",
      "content": "...",
      "toolCalls": [
        { "id": "call_1", "name": "tool_name", "arguments": "{\"x\":1}" }
      ]
    },
    { "role": "tool", "toolCallId": "call_1", "content": "..." }
  ],
  "sessionKey": "default",
  "flush": true
}
```

`mem_save_fact` records durable user facts to the personal/profile path. It is
not a trajectory tool and does not accept tool roles or tool calls. Prefer it
when the user states a preference, habit, trait, or decision that should
survive future sessions.

## MCP Resources

Resources are the read-only counterpart to the MCP tools for hosts that expose
`resources/read` to the model but do not expose `tools/call`.

| Resource | Meaning |
|---|---|
| `mem://profile` | User profile and relevant context, equivalent to a read-side `mem_context`. |
| `mem://search?q={query}&topK={topK}` | Semantic memory search, equivalent to `mem_search`. |

Both resources return `text/markdown` in `contents[0].text`.

`mem://search` accepts `q` or `query`, and `topK` or `top_k`. Empty queries are
errors. `topK` defaults to the configured topK or `5`, and is capped at `50`.

There is no resource equivalent for `mem_save_turn` or `mem_save_fact` because
MCP resources are read-only.

## Token Redaction

EverMe treats token redaction as a public safety contract.

The CLI redacts full-form `emk_*` and `evt_*` credentials before bytes leave
the output layer in JSON, YAML, and text output. The mask preserves the first
eight characters and replaces the rest with `_REDACTED`, for example:

```text
emk_a1b2_REDACTED
evt_a1b2_REDACTED
```

Short prefixes such as `emk_a1b2` and `evt_a1b2` are intentionally allowed so
support and install output can correlate accounts without exposing full
secrets.

The plugin SDK applies the same defense-in-depth rule before exposing text to
host logs, MCP tool results, MCP resource text, or host model context. It also
redacts S3 signing query parameters and AWS access key IDs that may appear in
temporary upload URLs or upstream error messages.

Do not add examples, tests, logs, filenames, issue templates, or docs that
contain real `emk_*` keys, `evt_*` tokens, cookies, presigned URLs, or private
logs.

## Change Checklist

When changing any CLI output, MCP surface, or redaction rule:

1. Keep stdout/stderr separation intact.
2. Preserve existing JSON/YAML field names and types.
3. Preserve exit-code meaning.
4. Add regression tests for envelopes, error types, MCP tools/resources, or redaction.
5. Update this document and the changelog.
6. Treat release/publish automation as secret-bearing infrastructure; do not add it to the public repository without a maintainer-approved secret model.
