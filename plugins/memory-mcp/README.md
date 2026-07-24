# @everme/memory-mcp

Generic **MCP server** for the EverMe memory backend. It supports local stdio hosts, hosted stateless Streamable HTTP, and authenticated HTTP+SSE for compatibility with cloud MCP clients such as Manus. Use this from any MCP-speaking host that doesn't have a native EverMe package — e.g. Cursor, Cline, or a generic JSON-RPC client.

If you're on:

- **Claude Code** → use [`@everme/claude-code`](https://www.npmjs.com/package/@everme/claude-code) (native plugin: hooks + commands + skills + this MCP server)
- **OpenClaw** → use [`@everme/openclaw`](https://www.npmjs.com/package/@everme/openclaw) (ContextEngine plugin)
- **Anything else MCP** → use this package

## Tools exposed

```
mem_context        server-rendered context block (profile + episodes)
mem_search         hybrid memory search (text + vector)
mem_save_fact      durable user fact → long-term profile
mem_save_turn      realtime trajectory write to /mem/agent-memory (no records)
```

Each tool's MCP `description` carries its own trigger so the host LLM
calls it **autonomously** (load context at session start, recall on a
back-reference, save a stated fact) without the user having to ask. The
server also advertises the same protocol via MCP `instructions` for
hosts that surface it. `mem_search` is guided to keep its `query` short
— a few keywords, not the whole conversation pasted in — and to use the
default `topK` (10), so requests stay small and search quality stays high.

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

## Hosted HTTP mode

The package also exposes `everme-memory-mcp-http`, a Node HTTP service for
cloud agents that cannot spawn a local stdio process. All MCP protocol
endpoints require an EverMe agent token:

```http
Authorization: Bearer evt_...
```

Start an installed package with:

```bash
EVERME_API_BASE=https://api.everme.evermind.ai \
HOST=0.0.0.0 PORT=3000 \
everme-memory-mcp-http
```

Or run the published executable without a global install:

```bash
EVERME_API_BASE=https://api.everme.evermind.ai \
npx -y -p @everme/memory-mcp everme-memory-mcp-http
```

Terminate TLS at the production load balancer or reverse proxy. Do not pass an
`emk_*` account key or a cloud-memory provider key to these endpoints; the
client credential is an `evt_*` EverMe agent token. Hosted mode does not require
`EVERME_AGENT_ID` because the EverMe BFF derives the agent identity from that
token.

The service exposes:

| Endpoint | Transport | Purpose |
|---|---|---|
| `POST /mcp` | Streamable HTTP | Stateless requests for modern MCP clients |
| `GET /sse` | HTTP+SSE | Opens an authenticated compatibility session for Manus |
| `POST /messages?sessionId=...` | HTTP+SSE | Sends JSON-RPC messages to the authenticated SSE session |
| `GET /health` | HTTP | Unauthenticated load-balancer health check |

Each Streamable HTTP request creates a fresh MCP server, transport, and EverMe
client. SSE sessions retain their own MCP server until disconnect and are bound
to the SHA-256 digest of the token that opened them; `/messages` rejects a
different token even when the caller knows the session id. No credential-bearing
client is shared across requests, sessions, or tenants. The MCP layer continues
to call only EverMe's stable `/api/v1/mem/*` BFF; cloud-memory V1/V2 routing stays
behind the BFF and is invisible to clients.

| Variable | Default | Purpose |
|---|---:|---|
| `EVERME_API_BASE` | `https://api.everme.evermind.ai` | EverMe BFF origin |
| `HOST` | `0.0.0.0` | Listener address |
| `PORT` | `3000` | Listener port |
| `MCP_HTTP_MAX_BODY_BYTES` | `1048576` | Maximum JSON request body (1 MiB) |
| `MCP_HTTP_RATE_LIMIT` | `60` | Requests allowed per token digest per window |
| `MCP_HTTP_RATE_WINDOW_MS` | `60000` | Fixed rate-limit window in milliseconds |
| `MCP_HTTP_TOKEN_VALIDATION_MAX_PENDING` | `100` | Maximum concurrent validations for distinct new tokens |

Before a new digest enters the limiter, hosted mode validates the token through
the stable BFF `/mem/capabilities` route; failed credentials consume no limiter
capacity. Successful validation is cached for the current window, and at most
10,000 validated token digests are tracked in memory. Duplicate validations for
one token are coalesced, while concurrent validations for distinct new tokens
are capped at 100 by default. A horizontally scaled deployment should also
enforce shared per-IP and global limits at ingress.

For Manus, generate a remote-agent credential from the EverMe Connect page,
open the Manus MCP JSON importer, and paste the generated configuration:

```json
{
  "mcpServers": {
    "everme": {
      "transport": "sse",
      "url": "https://api.everme.evermind.ai/sse",
      "headers": {
        "Authorization": "Bearer evt_..."
      }
    }
  }
}
```

The token is returned once. Regenerating the Manus configuration rotates the
token and invalidates the previous configuration.

## Architecture

Thin adapter on top of [`@everme/agent-sdk`](https://www.npmjs.com/package/@everme/agent-sdk). This package owns the MCP framing (stdio, stateless Streamable HTTP, or HTTP+SSE), tool list, and dispatch. Everything else — the EverMe BFF client, realtime agent-memory writes, search/context calls, retry, and redaction — comes from the SDK.

## Tests

```
npm test
```

## License

Apache-2.0
