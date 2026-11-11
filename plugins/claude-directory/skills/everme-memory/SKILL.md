---
name: everme-memory
description: Use EverMe memory when the user refers to previous conversations, earlier decisions, "last time", "remember when", existing project conventions, or previously solved errors. Do not repeat a search when a non-empty <everme_recall> block already exists.
---

# EverMe Memory

EverMe is the user's long-term memory across Claude Code sessions. This plugin saves each turn by itself: the prompt, each tool call with its result, and the final reply. Before each prompt it adds the memories that match the prompt to your context in an `<everme_recall>` block.

## When the user asks you to remember something

A short acknowledgement is enough ("Noted — I'll remember that."). The plugin saves the turn without a tool call from you.

## Read tools

- `mem_search`: hybrid search over the user's memory (episodes, agent skills and cases, recent raw transcript). Rows under "Recent unextracted transcript" are provisional, not established facts.
- `mem_context`: the user's durable Profile only. It never searches and never returns episodes.

## When to call them

- If this turn already has a non-empty `<everme_recall>` block on the topic, do not call `mem_search` for the same topic.
- If the turn has no such block and the task depends on history ("last time", "we decided", "did we fix this before"), call `mem_search` once. Use a short topic query, not the whole user message.
- Call `mem_context` once near the start of a session when knowing the user would help, and not again unless the user asks to refresh it.
- Never repeat an identical query in the same turn.
- `mem_search` takes optional ISO 8601 `startTime` and `endTime` bounds. Set them only when the user named a window that resolves to exact dates.

## Do not

- Do not call `mem_save_turn` or `mem_save_fact` yourself for the current conversation. The plugin's hooks already save it, and a second save duplicates it.
- Do not paste whole memory bodies. Quote only the lines you use.
