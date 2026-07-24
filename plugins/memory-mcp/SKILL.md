---
name: everme-memory
description: Real-time access to EverMe cloud memory from AI Agents (Claude Code, OpenClaw, …)
version: 0.1.0
---

# What it gives you

When this plugin is loaded, the host has these MCP tools available:

| tool            | input                                                          | output (markdown / JSON)                       |
|-----------------|----------------------------------------------------------------|------------------------------------------------|
| `mem_context`   | `{ query }`                                                    | markdown context block (profile + episodes)    |
| `mem_search`    | `{ query, topK? }`                                             | markdown search results                        |
| `mem_save_fact` | `{ fact \| messages, sessionKey?, flush? }`                   | `{ saved, status, extracted, … }`              |
| `mem_save_turn` | `{ role, text \| messages, sessionKey?, toolCallId?, flush? }` | `{ saved, status, messageCount, flushed }`     |

# Recommended usage

**Call these tools autonomously — the moment a trigger fires, not only
when the user explicitly asks you to "remember" or "recall".** Each
tool's MCP `description` also carries its trigger, so hosts that don't
surface the server `instructions` still get the same guidance.

## At the start of a session — `mem_context`

Call `mem_context` once with the user's first message as the `query`,
before answering it. Splice the returned markdown into your reasoning
context. The server already returns a trimmed, relevance-ranked block,
so call it **once per session**, not on every turn.

```ts
const context = await tools.mem_context({ query: userPrompt });
if (context) systemAddition += "\n" + context;
```

## When the user references prior context — `mem_search`

Call `mem_search` when the user points back at earlier conversations or
decisions ("what did we say about X", "remember when…", "like last
time"). **Keep `query` short** — a few keywords or one short phrase
naming the topic; do NOT paste in the whole conversation or the full
user message, a long query searches worse and bloats the request. Rely
on the default `topK` of 5; only raise it if a first search genuinely
missed.

## When the user states a durable fact — `mem_save_fact`

When the user says something true about themselves that should outlive
this conversation (a preference, habit, trait, or decision), call
`mem_save_fact` so it lands in their long-term profile. Only
`extracted: true` confirms the fact reached the profile.

## To capture how a task was solved — `mem_save_turn`

When a task is solved in a way worth reusing, call `mem_save_turn` with
the trajectory. It writes synchronously through `/mem/agent-memory` and
does not create `/mem/sources`. `sessionKey` becomes the conversation
id; use a stable value for the whole chat.

# Error handling

Tools return `isError: true` with `content[0].text` carrying a short
description on failure. Common shapes:

- `auth` — emk/evt revoked or expired. Re-run `evercli auth login`
  and `evercli plugin install <agent>` to refresh.
- `network` — backend unreachable; retry with backoff.
- `upstream` — backend returned non-zero status. The error message
  includes the requestId for support correlation.

Cold-start memory (everything the user already had) is loaded by
`evercli import run`; you don't need to re-upload it from inside the
agent.
