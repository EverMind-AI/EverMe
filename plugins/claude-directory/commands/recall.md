---
description: Recall relevant EverMe memories from past sessions and use them as context for the current task.
argument-hint: <what to look up>
---

# EverMe · recall

## Query

$ARGUMENTS

## Instructions

1. Call `mem_search` with a short version of the query. Start with `topK: 10`.
2. If the returned memories are relevant, summarize them briefly and use them to answer or guide the next action.
3. If results are weak or empty, retry once with broader keywords. If there is still nothing useful, say so. Do not invent context.
4. Treat rows under "Recent unextracted transcript" as provisional, not as established facts or confirmed decisions.
5. Quote only the salient parts of a memory, never a whole long memory body.
