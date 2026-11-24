# @everme/openclaw

EverMe **ContextEngine plugin for OpenClaw**. Real-time memory recall + persistence wired into OpenClaw's plugin lifecycle.

## What it does

OpenClaw plugins of `kind: "context-engine"` get five lifecycle callbacks; this plugin implements them against the EverMe gateway:

| Hook | Behaviour |
|---|---|
| `bootstrap()` | Resolve config (env + host overrides), ping `/healthz`, init session state |
| `assemble({ messages, sessionKey })` | Call `/mem/search`, render all returned memory sections, and return `{ messages, systemPromptAddition, estimatedTokens }` for OpenClaw to inject into the prompt |
| `afterTurn({ messages, sessionKey })` | Write the raw turn to `/mem/agent-memory` with `conversationId=sessionKey`; failures are logged and never fall back to `/mem/sources` |
| `commitTurn({ advancementKey, messages, sessionKey })` | OpenClaw 2026.8 and later: write the accepted turn, skipping messages `afterTurn` already wrote; return `committed`, or `duplicate` for a key already committed |
| `compact()` | Flush pending extraction before OpenClaw compacts local context |
| `dispose({ sessionKey? })` | Best-effort flush (3-second bound) of the sessions this engine served |

## OpenClaw 2026.8 and later: durable turns

From 2026.8, OpenClaw runs a non-legacy context engine on an admitted turn
only if `info.transcriptSemantics` declares
`currentTurnFence: "before-current-turn-entry-v1"` and
`turnAdvancementIdempotency: "atomic-idempotent-v1"`, and the engine
implements `commitTurn`. Without them OpenClaw silently uses its `legacy`
engine for the turn, so EverMe neither recalls nor writes. This plugin
declares both.

- **Write path.** OpenClaw 2026.8.1 and 2026.10.8 call `commitTurn` after an
  accepted turn and do not call `afterTurn` for it. Older releases call only
  `afterTurn`. If a host calls both, `commitTurn` writes only the messages
  `afterTurn` did not write.
- **Retries.** OpenClaw keeps an accepted turn in a durable outbox until
  `commitTurn` returns. A failed write throws once, so OpenClaw retries the
  turn before the next one. The second failure drops the turn and returns
  `committed`, because a turn still in the outbox makes OpenClaw use `legacy`
  for the next turn.
- **One write at a time.** OpenClaw 2026.8.1 can hand a turn that is still
  in its outbox to the next run's engine while the first engine still commits
  it. The plugin runs the writes of one session one at a time, so the second
  call finds the turn already written and writes nothing.
- **Turn claims.** Under the fence, `assemble` receives only the history
  before the current user entry. An empty history marks the session's first
  turn, and the plugin writes that turn with `baseTurn: 0`. The plugin claims
  each user message once. If a write times out or loses its connection, the
  write can still land, so the retry claims no turn for those messages. If
  the Server answers with an error, the retry claims them again.
- **State.** OpenClaw builds a new engine for every run and disposes it when
  the run ends (2026.7 does too). Session cursors and the commit ledger live
  at module scope, so they last for the gateway process. A new process, such
  as each `openclaw agent --local` run, starts with no cursor, so its first
  write claims no turn.

Native `toolCall.id` and `toolResult.toolCallId` must be non-blank strings.
Invalid records are dropped with aggregate warning counts; the adapter never
generates replacement IDs or guesses call/result associations. Valid IDs and
source result order are preserved, including empty tool results.

Native calls also require a non-blank name. Arguments are serialized to a JSON
string for the gateway; already encoded strings must contain valid JSON.
Invalid calls are dropped without substituting a name or repairing arguments;
only results uniquely identified by that native call ID are dropped with them.
Duplicate source IDs are not used to guess result ownership. Diagnostics contain
aggregate counts rather than source content.

User and assistant transcript text preserves literal protocol examples and
metadata headings. Current native OpenClaw stores inbound context separately as
non-displayed runtime `custom` records; these are excluded by role, not by
matching headings inside user text. Legacy inline envelopes without native
provenance are not guessed or removed. Text normalization, existing ordinary
message budgets, and credential redaction remain in effect.

## Where memory is kept

Without EverMe Desktop, this plugin saves memory in the EverMe cloud. To keep memory only on this Mac, install EverMe Desktop and turn on local memory. The plugin then sends memory to the local memory gateway that EverMe Desktop runs (it reads `~/.everme/memory/route.json` on each request).

Each EverMe account keeps its memory in one place: the cloud, or one Mac. If your account keeps its memory on another Mac, the cloud refuses memory from this computer, and the error names that Mac. To save memory from here, switch the account back to the cloud on that Mac, or on the web if that Mac is gone.

## Configuration

Live turns and cold import use task-aware batching. Fitting user tasks keep
original tool output; oversized tasks try 4, 3, then 2 KiB result budgets before
semantic splitting. Native call IDs, arguments, message order, and configured
flush cadence are unchanged.

Wired through OpenClaw's `plugins.entries["@everme/openclaw"].config`:

```jsonc
{
  "plugins": {
    "allow": ["@everme/openclaw"],
    "slots": {
      "memory": "none",                           // disable other memory slots
      "contextEngine": "@everme/openclaw"         // pin us as THE engine
    },
    "entries": {
      "@everme/openclaw": {
        "enabled": true,
        "config": {
          "apiBase": "https://api.everme.evermind.ai",
          "agentId": "agt_...",                    // written by `evercli plugin install openclaw`
          "agentToken": "evt_...",                 // ditto — secret, never logged
          "topK": 5,
          "flushEveryTurns": 5,                    // extraction cadence; EVERME_FLUSH_MODE=legacy restores every-turn flush
          "flushMaxBytes": 65536                   // realtime writes do not buffer by byte size
        }
      }
    }
  }
}
```

`evercli plugin install openclaw` writes this block automatically (and updates the agent registration on the EverMe backend).

Native assistant `stopReason=stop` with visible text and no tool calls marks
a complete turn for request batching. Length limits, failures, aborted replies,
and tool calls do not imply completion. No assistant conclusion is invented.

Each normal turn is uploaded with `flush:false`; every fifth turn triggers
extraction, while `compact` and `dispose` send flush-only requests. Setting both
`flushEveryTurns` and `flushMaxBytes` to `0` disables per-turn uploads but keeps
the lifecycle safety flushes.

## Architecture

Thin adapter on top of [`@everme/agent-sdk`](https://www.npmjs.com/package/@everme/agent-sdk). The engine itself is lifecycle plumbing + session-key bookkeeping; the SDK provides the HTTP client, realtime agent-memory write helper, search/context calls, and redaction. Document uploads (`/mem/sources`) remain available to other hosts and import flows, but OpenClaw runtime turns do not use them.

## Tests

```
npm test
```

## License

Apache-2.0

## Compacted context boundaries

`afterTurn` uses the host's `prePromptMessageCount` to select the current
turn. A previously saved array length cannot override that boundary after
compaction. The adapter does not send `baseTurn` after the first turn:
context indices are not durable session ordinals. Every write declares
`deduplication: "client-native-id"`, so the Server session gate does not trim
it by timestamp. Without the field, the gate drops each message that is older
than the newest message the session already landed. The plugin prevents
re-sends with the cursor, the uploaded message keys and the commit ledger. A
re-send that gets through keeps the host timestamps, and EverOS skips it by
message ID. This is not an exactly-once guarantee. Legacy callers without a
host boundary keep the cursor fallback. The change does not migrate stored
watermarks.
