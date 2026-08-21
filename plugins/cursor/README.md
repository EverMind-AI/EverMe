# @everme/cursor

Native EverMe lifecycle hook runner for Cursor. It keeps memory traffic on
EverMe's stable `/api/v1/mem/*` BFF contract.

## Lifecycle

- `sessionStart`: inject the EverMe profile snapshot through
  `additional_context`.
- `postToolUse`: spool the tool call (name, input, output) to a local
  per-conversation buffer under the state dir. No network happens here.
- `stop`: stream the Cursor transcript, attach the spooled tool calls of
  this turn, and save the latest user turn.
- `preCompact`: send a flush-only request before context compaction.

Cursor's transcript intentionally omits tool outputs, and its 3.16+ typed
event stream may summarize native-tool arguments, so the spooled
`postToolUse` payloads are the authoritative tool trace. When the spool is
empty (hook not registered, older install) the transcript's own
`tool_call` / `tool_use` records are kept as an inputs-only fallback, and
unknown transcript record types are reported on stderr instead of being
silently dropped.

Cursor's current `beforeSubmitPrompt` output supports allow/block decisions and
a user-visible message, but not hidden model context. The package therefore
does not register that event as automatic recall. Use the `everme-memory` MCP
tools for per-prompt recall.

All hook failures are fail-open and credentials are redacted from diagnostics.
`evercli plugin install cursor` writes credentials to
`~/.cursor/everme.env` with mode `0600`.

## Configuration

The shared hook knobs are `EVERME_INJECT_TOPK`, `EVERME_INJECT_PROFILE`,
`EVERME_INJECT_MIN_SCORE`, `EVERME_FLUSH_EVERY_TURNS`,
`EVERME_FLUSH_MODE`, and `EVERME_STATE_DIR`.

## License

Apache-2.0.
