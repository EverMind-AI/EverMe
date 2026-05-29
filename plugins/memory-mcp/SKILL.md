---
name: everme-memory
description: Real-time access to EverMe memory from AI Agents (Claude Code, OpenClaw, …)
version: 0.2.0
---

# What it gives you

When this plugin is loaded, the host has these MCP tools available:

| tool                | input                              | output                                        |
|---------------------|------------------------------------|-----------------------------------------------|
| `mem_search`        | `{ query, topK? }`                 | raw markdown text in `content[0].text`        |
| `mem_context`       | `{ query }`                        | raw markdown text in `content[0].text`        |
| `mem_save_fact`     | `{ fact, sessionKey?, flush? }` or `{ messages[], sessionKey?, flush? }` | JSON text with `{ saved, status, messageCount, flushed, extracted }` |
| `mem_save_turn`     | `{ messages[], sessionKey?, flush? }` or legacy `{ role, text, ... }` | JSON text with `{ saved, status, messageCount, flushed }` |

# Recommended usage

## Before answering a user prompt

Call `mem_context` with the user's question. Splice the returned
markdown text into your reasoning context (or the system prompt
addition). This is the cheapest, server-assembled retrieval path.

```ts
const res = await tools.mem_context({ query: userPrompt });
const text = res.content?.[0]?.text || "";
if (text) systemAddition += "\n" + text;
```

## To save durable facts

When the user states a preference, habit, trait, or decision that should
survive future sessions, call `mem_save_fact`. This writes to the
personal/profile path. Do not use `mem_save_turn` for these facts; that
tool records conversation trajectories and does not update the profile.

## To capture conversation turns

For MCP hosts that don't support native lifecycle hooks, call
`mem_save_turn` to preserve the conversation trajectory. Prefer the
`messages[]` form so assistant tool calls and tool results stay in the
same saved trajectory. It writes synchronously through
`/mem/agent-memory` and does not create `/mem/sources`. `sessionKey`
becomes the conversation id; use a stable value for the whole chat.

# Error handling

Tools return `isError: true` with `content[0].text` carrying a short
description on failure. Common shapes:

- `auth` — `emk_*` / `evt_*` revoked or expired. Re-run `evercli auth login`
  and `evercli plugin install <agent>` to refresh.
- `network` — backend unreachable; retry with backoff.
- `upstream` — backend returned non-zero status. The error message
  includes the requestId for support correlation.

Cold-start memory (everything the user already had) is loaded by
`evercli import run`; you don't need to re-upload it from inside the
agent.
