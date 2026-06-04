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

**Call these tools autonomously — the moment a trigger fires, not only
when the user explicitly asks you to "remember" or "recall".** Each
tool's MCP `description` also carries its trigger, so hosts that don't
surface the server `instructions` still get the same guidance.

## At the start of a session — `mem_context`

Call `mem_context` once with the user's first message as the `query`,
before answering it. Splice the returned markdown text into your
reasoning context (or the system prompt addition). The server already
returns a trimmed, relevance-ranked block, so call it **once per
session**, not on every turn.

```ts
const res = await tools.mem_context({ query: userPrompt });
const text = res.content?.[0]?.text || "";
if (text) systemAddition += "\n" + text;
```

## When the user references prior context — `mem_search`

Call `mem_search` when the user points back at earlier conversations or
decisions ("what did we say about X", "remember when…", "like last
time"). **Keep `query` short** — a few keywords or one short phrase
naming the topic; do NOT paste in the whole conversation or the full
user message, a long query searches worse and bloats the request. Rely
on the default `topK` of 5; only raise it if a first search genuinely
missed.

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
