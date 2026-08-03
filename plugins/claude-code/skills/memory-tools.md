---
description: Use EverMe memory proactively when the user refers to previous conversations, earlier decisions, "last time", "remember when", existing project conventions, or previously solved errors, and save durable user preferences, habits, and decisions the moment they are stated. Do not repeat a search when a non-empty <everme_recall> block already exists.
alwaysInclude: true
---

# EverMe Memory Tools

You have four canonical MCP tools for memory EverMe persists across past Claude Code sessions:

Recall:
- `mem_search` — semantic + keyword hybrid search over the user's memory store (episodic, profile, agent cases/skills, recent raw transcript). Rows under "Recent unextracted transcript" are provisional, not established facts.
- `mem_context` — the user's durable Profile snapshot ONLY. It never searches and never returns episodes; do not use it to recall past decisions or task context.

Write:
- `mem_save_fact` — save a durable user fact (preference, habit, trait, long-term decision). Call it proactively the moment the user states one ("以后文档签名用 Alice", "I hate Friday meetings") — do NOT wait for the user to say "remember this".
- `mem_save_turn` — persist a complete task trajectory worth reusing. Chat-dual-write backends may also update the user's Profile; check `profileUpdated`. Use `mem_save_fact` for a deliberate durable fact.

## Dedupe protocol (hooks come first)

The plugin's native hooks already inject `<everme_profile>` at session start and `<everme_recall>` before each prompt, and they save the conversation automatically. So:

- If this turn already carries a non-empty, relevant `<everme_recall>` block — do NOT call `mem_search` for the same topic.
- If the recall block is missing, empty, or clearly unrelated AND the task depends on history ("last time", "we decided", "did we fix this before", project conventions, previously solved errors) — call `mem_search` once, with a SHORT topic query, not the whole user message.
- Never repeat an identical query within the same turn.
- Call `mem_context` only when no `<everme_profile>` block was injected this session.

## Save honesty

`mem_save_fact` returns the real extraction verdict. Only `extracted: true` / `profileUpdated: true` means the profile updated — then you may tell the user the fact is remembered. On `status: "no_extraction"` the profile did NOT update: say so plainly, do not auto-retry, and do not claim success.

## Best practices

1. Search with the user's specific terms first; only broaden if zero hits.
2. Cite memories by subject so the user can trace them.
3. Synthesize, don't copy-paste — quote the relevant lines, not whole memory bodies.
4. If recall returns conflicting info ("two prior sessions disagree"), say so and ask the user which is current.
5. The user's emk / evt is a credential — never echo it back, even when EverMe-related errors surface.
