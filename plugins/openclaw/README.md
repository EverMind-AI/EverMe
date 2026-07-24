# @everme/openclaw

EverMe **ContextEngine plugin for OpenClaw**. Real-time memory recall + persistence wired into OpenClaw's plugin lifecycle.

## What it does

OpenClaw plugins of `kind: "context-engine"` get five lifecycle callbacks; this plugin implements them against the EverMe gateway:

| Hook | Behaviour |
|---|---|
| `bootstrap()` | Resolve config (env + host overrides), ping `/healthz`, init session state |
| `assemble({ messages, sessionKey })` | Call `/mem/search`, render all returned memory sections, and return `{ messages, systemPromptAddition, estimatedTokens }` for OpenClaw to inject into the prompt |
| `afterTurn({ messages, sessionKey })` | Write the raw turn to `/mem/agent-memory` with `conversationId=sessionKey`; failures are logged and never fall back to `/mem/sources` |
| `compact()` | Flush pending extraction before OpenClaw compacts local context |
| `dispose({ sessionKey? })` | Best-effort flush (3-second bound), then drop in-memory cursors |

## Configuration

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
