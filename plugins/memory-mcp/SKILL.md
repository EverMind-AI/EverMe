---
name: everme-memory
description: |
  Use EverMe cloud memory proactively when the user refers to previous
  conversations, earlier decisions, "last time", "remember when", existing
  project conventions, or previously solved errors, and save durable user
  preferences, habits, and decisions the moment they are stated. Do not
  repeat a search when the host already injected a non-empty
  <everme_recall> block this turn.
---

# What it gives you

When this plugin is loaded, the host has these MCP tools available:

| tool            | input                                                          | output (markdown / JSON)                                    |
|-----------------|----------------------------------------------------------------|-------------------------------------------------------------|
| `mem_context`   | `{ forceRefresh? }` (`query` deprecated/ignored)               | markdown Profile snapshot — Profile ONLY, never a search    |
| `mem_search`    | `{ query, topK? }`                                             | markdown search results across all memory buckets           |
| `mem_save_fact` | `{ fact \| messages, sessionKey?, flush? }`                   | `{ saved, accepted, status, extracted, profileUpdated, … }` |
| `mem_save_turn` | `{ role, text \| messages, sessionKey?, toolCallId?, flush? }` | `{ saved, accepted, status, messageCount, flushed, profileStatus, profileUpdated }` |

# Recommended usage

**Call these tools autonomously — the moment a trigger fires, not only
when the user explicitly asks you to "remember" or "recall".** Each
tool's MCP `description` also carries its trigger, so hosts that don't
surface the server `instructions` still get the same guidance.

**Dedupe with native injection first.** Some hosts inject
`<everme_profile>` at session start and `<everme_recall>` before each
prompt via native hooks. When a non-empty, relevant block is already in
your context, do not fetch the same data again through these tools; when
the block is missing or clearly unrelated and the task depends on
history, call the tools proactively.

## At the start of a session — `mem_context`

If no `<everme_profile>` block was injected, call `mem_context` once
before answering the first user message. It returns the user's durable
Profile ONLY — no semantic search, no episodes, no raw transcript. Call
it **once per session**; pass `forceRefresh: true` only when the user
explicitly asks to refresh. Never use it as a fallback for recalling
past decisions or task context — that is `mem_search`'s job.

## When the user references prior context — `mem_search`

Call `mem_search` when the user points back at earlier conversations,
decisions, conventions, or previously solved problems ("what did we say
about X", "remember when…", "like last time", "did we fix this
before"). **Keep `query` short** — a few keywords or one short phrase
naming the topic; do NOT paste in the whole conversation. Rely on the
default `topK` of 10; only raise it if a first search genuinely missed.
Do not repeat an identical query within the same turn.

Results cover episodic memories, profile entries, agent cases/skills,
and the recent raw transcript. Rows under "Recent unextracted
transcript" are provisional — not yet extracted — never quote them as
established facts or confirmed decisions.

## When the user states a durable fact — `mem_save_fact`

When the user says something true about themselves that should outlive
this conversation (a preference, habit, trait, long-term goal, or
decision), call `mem_save_fact` — without waiting to be asked. Only
`extracted: true` / `profileUpdated: true` confirms the fact reached
the profile; on `status: "no_extraction"` the profile did NOT update —
say so plainly, do not auto-retry, and do not claim success.

## To capture how a task was solved — `mem_save_turn`

When a task is solved in a way worth reusing, call `mem_save_turn` with
the complete trajectory (user → assistant tool calls → tool results →
final answer). It feeds episodic / agent_case / agent_skill extraction.
On chat-dual-write backends, the derived user/assistant transcript may also
update the user's Profile; check `profileUpdated` for that verdict.
`sessionKey` becomes the conversation id; use a stable value for the whole
chat. Use `mem_save_fact` for a deliberate durable fact rather than relying
on the derived chat write. If your host's native hooks already saved the turn,
do not save it again.

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
