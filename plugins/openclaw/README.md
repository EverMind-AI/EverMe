# @everme/openclaw

EverMe **ContextEngine plugin for OpenClaw**. Real-time memory recall + persistence wired into OpenClaw's plugin lifecycle.

## What it does

OpenClaw plugins of `kind: "context-engine"` get five lifecycle callbacks; this plugin implements them against the EverMe gateway:

| Hook | Behaviour |
|---|---|
| `bootstrap()` | Resolve config (env + host overrides), ping `/healthz`, init session state |
| `assemble({ messages, sessionKey })` | Call `/mem/context` (or `/mem/search` fallback), render a memory block, return `{ messages, systemPromptAddition, estimatedTokens }` for OpenClaw to inject into the prompt |
| `afterTurn({ messages, sessionKey })` | Write the raw turn to `/mem/agent-memory` with `conversationId=sessionKey`; failures are logged and never fall back to `/mem/sources` |
| `compact()` | No-op — EverMe is the source of truth, OpenClaw decides locally |
| `dispose({ sessionKey? })` | Drop in-memory cursors; runtime persistence is already handled by `afterTurn` |

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
          "flushEveryTurns": 5,                    // legacy switch; 0 with flushMaxBytes=0 disables runtime writes
          "flushMaxBytes": 65536                   // realtime writes do not buffer by byte size
        }
      }
    }
  }
}
```

`evercli plugin install openclaw` writes this block automatically (and updates the agent registration on the EverMe backend).

## Architecture

Thin adapter on top of [`@everme/agent-sdk`](https://www.npmjs.com/package/@everme/agent-sdk). The engine itself is lifecycle plumbing + session-key bookkeeping; the SDK provides the HTTP client, realtime agent-memory write helper, search/context calls, and redaction. Document uploads (`/mem/sources`) remain available to other hosts and import flows, but OpenClaw runtime turns do not use them.

## Tests

```
npm test
```

## License

Apache-2.0
