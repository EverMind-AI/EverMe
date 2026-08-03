---
description: Recall relevant EverMe memories from past sessions and use them as context for the current task.
arguments:
  - name: query
    description: What to look up — keywords, topic, or a question.
    required: true
---

# EverMe · recall

Use the canonical EverMe MCP tools:

- `mem_search` — hybrid search across episodic memories, profile entries, agent cases/skills, and the recent raw transcript.
- `mem_context` — durable Profile snapshot only; it does not search past conversations and is not needed for this command.

## Query

{{query}}

## Instructions

1. Call `mem_search` with a short version of the query. Start with `topK: 10`.
2. If the returned memories are clearly relevant, summarize them briefly and use them to answer or guide the next action.
3. If results are weak or empty, retry once with broader keywords. If still nothing useful, say so explicitly — do not fabricate context.
4. Treat rows under "Recent unextracted transcript" as provisional, not as established facts or confirmed decisions.
5. When citing a memory, mention its subject or session id when available so the user can trace it through `evercli` or the EverMe Web UI.
6. NEVER paste an entire long memory body verbatim; quote only the salient parts.
