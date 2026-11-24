---
description: Use EverMe memory proactively when the user refers to previous conversations, earlier decisions, "last time", "remember when", existing project conventions, or previously solved errors. Do not repeat a search when a non-empty <everme_recall> block already exists.
alwaysInclude: true
---

# EverMe Memory

EverMe is the user's long-term memory across Claude Code sessions. On this host it listens to the conversation itself: what matters — preferences, decisions, the work you do together — is kept without anyone saving it by hand, and comes back into your context through the `<everme_profile>` block at session start and the `<everme_recall>` block before each prompt.

## When the user asks you to remember something

You already can. A short acknowledgement is enough ("Noted — I'll remember that."), then carry on with the task. There is nothing to call and nothing to set up. If the user asks how it works, "EverMe keeps a memory of our conversations" is the whole story from their side — the mechanics are not something to narrate, and there is nothing to work around.

## Three read tools

- `mem_search` — semantic + keyword hybrid search over the user's memory store (episodic, profile, agent skills, recent raw transcript). Rows under "Recent unextracted transcript" are provisional, not established facts.
- `mem_context` — the user's durable Profile snapshot ONLY. It never searches and never returns episodes; do not use it to recall past decisions or task context.
- `mem_skill` — the full text of ONE agent skill, by the id printed in its `[skill <id>]` line. The search result carries each skill's name and one-line summary only; call this when a summary looks like it applies to the task in hand. An id that was not returned by a search on this machine is reported as a miss, not approximated.

## When to call them (the injected blocks come first)

- If this turn already carries a non-empty, relevant `<everme_recall>` block — do NOT call `mem_search` for the same topic.
- If the recall block is missing, empty, or clearly unrelated AND the task depends on history ("last time", "we decided", "did we fix this before", project conventions, previously solved errors) — call `mem_search` once, with a SHORT topic query, not the whole user message.
- Never repeat an identical query within the same turn.
- `mem_search` takes optional ISO 8601 `startTime` / `endTime` bounds on when the conversation happened. Set them only when the user named a window that resolves to exact dates ("yesterday", "Sep 3", "last week"); leave them out for vague recency ("recently", "last time") and for dates that belong to the subject rather than the conversation ("which year did I graduate") — a wrong bound returns zero rows, which reads exactly like a topic that was never discussed.
- Call `mem_context` only when no `<everme_profile>` block was injected this session.

## Best practices

1. Search with the user's specific terms first; only broaden if zero hits.
2. Cite memories by subject so the user can trace them.
3. Synthesize, don't copy-paste — quote the relevant lines, not whole memory bodies.
4. If recall returns conflicting info ("two prior sessions disagree"), say so and ask the user which is current.
5. The user's emk / evt is a credential — never echo it back, even when EverMe-related errors surface.
