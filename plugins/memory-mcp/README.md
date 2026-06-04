# @everme/memory-mcp

Generic **MCP server** for the EverMe memory backend. Use this from any MCP-speaking host that doesn't have a native EverMe package — e.g. Cursor, Cline, generic JSON-RPC clients.

If you're on:

- **Claude Code** → use [`@everme/claude-code`](https://www.npmjs.com/package/@everme/claude-code) (native plugin: hooks + commands + skills + this MCP server)
- **OpenClaw** → use [`@everme/openclaw`](https://www.npmjs.com/package/@everme/openclaw) (ContextEngine plugin)
- **Anything else MCP** → use this package

## Tools exposed

```
mem_search         hybrid memory search (text + vector)
mem_context        server-rendered context block (profile + episodes)
mem_save_turn      realtime write to /mem/agent-memory (no /mem/sources record)
mem_save_fact      durable user fact write to personal/profile memory
```

Each tool's MCP `description` carries its own trigger so the host LLM
calls it **autonomously** (load context at session start, recall on a
back-reference, save a stated fact) without the user having to ask. The
server also advertises the same protocol via MCP `instructions` for
hosts that surface it. `mem_search` is guided to keep its `query` short
— a few keywords, not the whole conversation pasted in — and to use the
default `topK` (5), so requests stay small and search quality stays high.

Read-only MCP resources are also exposed for hosts that support
`resources/read`: `mem://profile` and `mem://search?q={query}&topK={topK}`.
The public MCP contract is documented in
[`../../docs/contracts.md`](../../docs/contracts.md).

## Wire it into a host's mcpServers config

```json
{
  "mcpServers": {
    "everme-memory": {
      "command": "npx",
      "args": ["-y", "@everme/memory-mcp"],
      "env": {
        "EVERME_API_BASE": "https://api.everme.evermind.ai",
        "EVERME_AGENT_ID": "agt_...",
        "EVERME_AGENT_TOKEN": "evt_..."
      }
    }
  }
}
```

`evercli plugin install <host>` writes this for hosts without a native plugin package.

## Architecture

Thin adapter on top of [`@everme/agent-sdk`](https://www.npmjs.com/package/@everme/agent-sdk). This package owns the MCP framing (stdio + JSON-RPC), tool list, and dispatch. Everything else — HTTP client, realtime agent-memory writes, search/context calls, retry, redaction — comes from the SDK.

## Tests

```
npm test
```

## License

Apache-2.0
