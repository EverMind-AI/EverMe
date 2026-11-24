# @everme/cursor

Native EverMe lifecycle hook runner for Cursor. It keeps memory traffic on
EverMe's stable `/api/v1/mem/*` BFF contract.

## Lifecycle

- `sessionStart`: inject the EverMe profile snapshot through
  `additional_context`.
- `postToolUse`: spool the native tool call (ID, name, input, output) to a local
  per-conversation buffer under the state dir. No network happens here.
- `stop`: stream the Cursor transcript, attach the spooled tool calls of
  this turn, and save the latest user turn.
- `preCompact`: send a flush-only request before context compaction.
- `sessionEnd`: flush the session. When no `stop` saved a turn in this
  session, first save the latest user turn as `stop` does. Cursor CLI in
  one-shot mode (`cursor-agent -p`, checked on 2026.11.17) fires `sessionEnd`
  but never `stop`. The hook starts a detached copy of itself to do this work
  and returns at once, because `cursor-agent -p` ends its hooks when it exits
  (checked on 2026-11-20).

Cursor's documented transcript behavior omits tool outputs, so the spooled
`postToolUse` payloads are the authoritative tool trace. When the spool is
empty (hook not registered, older install) the transcript's own
`tool_call` / `tool_use` records are kept only when they carry native IDs,
names, and valid JSON arguments. Missing IDs are never synthesized. Invalid
records are reported as fixed reason/count diagnostics on stderr, without
printing source record types or content.

The documented `postToolUse` contract requires a nonblank string `tool_use_id`
and `tool_name`, object `tool_input`, and string `tool_output`. IDs are preserved,
not generated. Malformed events are excluded with bounded, credential-free
diagnostics. Empty output stays empty, and tool inputs/results have no additional
8000-character cap. Credential redaction preserves JSON syntax and does not
rewrite numeric result values. The existing total spool-size limit still applies.

The [public Cursor 3.5.38 transcript](https://forum.cursor.com/t/afteragentthought-hook-cutting-off-start-of-message/161788)
uses top-level roles, text blocks, ID-less tool blocks, and an outer user query
envelope. The reader strips only that outer envelope and excludes ID-less calls
with diagnostics. Removing an invalid call does not turn its accompanying text
into a completed assistant turn. Empty native tool results remain empty; tool
arguments and results are not truncated by the transcript compatibility reader.
Ordinary user/assistant text retains its existing text cap.

That source also merges visible assistant text and thinking into one text block;
the host does not preserve their boundary there. We do not guess that boundary
from prose. The historical compatibility reader and spool-first merge are not
evidence of a clean, fully ordered trace for every Cursor version. In
particular, CLI `stream-json` stdout is not assumed to be a hook transcript, and
execution input is never used as a substitute for missing tool output. When
`transcript_path` is null, real `postToolUse` records can still be uploaded without
inventing user text or a closing assistant response.

Cursor's current `beforeSubmitPrompt` output supports allow/block decisions and
a user-visible message, but not hidden model context. The package therefore
does not register that event as automatic recall. Use the `everme-memory` MCP
tools for per-prompt recall.

All hook failures are fail-open and credentials are redacted from diagnostics.
`evercli plugin install cursor` writes credentials to
`~/.cursor/everme.env` with mode `0600`.

## Where memory is kept

Without EverMe Desktop, this plugin saves memory in the EverMe cloud. To keep memory only on this Mac, install EverMe Desktop and turn on local memory. The plugin then sends memory to the local memory gateway that EverMe Desktop runs (it reads `~/.everme/memory/route.json` on each request).

Each EverMe account keeps its memory in one place: the cloud, or one Mac. If your account keeps its memory on another Mac, the cloud refuses memory from this computer, and the error names that Mac. To save memory from here, switch the account back to the cloud on that Mac, or on the web if that Mac is gone.

## Configuration

The Stop writer opts into shared task-aware batching. Fitting tasks retain
tool output; oversized tasks try 4/3/2 KiB result budgets before splitting.
This does not add native tool IDs or resolve transcript/spool ordering limits.

The shared hook knobs are `EVERME_INJECT_TOPK`, `EVERME_INJECT_PROFILE`,
`EVERME_INJECT_MIN_SCORE`, `EVERME_FLUSH_EVERY_TURNS`,
`EVERME_FLUSH_MODE`, and `EVERME_STATE_DIR`.

## License

Apache-2.0.
