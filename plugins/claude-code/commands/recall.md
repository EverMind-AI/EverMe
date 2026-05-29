---
description: Recall relevant EverMe memories from past sessions and use them as context for the current task.
arguments:
  - name: query
    description: What to look up — keywords, topic, or a question.
    required: true
---

# EverMe · recall

You have access to two MCP tools backed by the EverMe gateway:

- `everme_search` — ranked search with subject + summary + score.
- `everme_context` — server-rendered context block (profile + recent episodes).

## Query

{{query}}

## Instructions

1. Call `everme_search` with the query. Start with `topK: 10`.
2. If the top results are clearly relevant (score ≥ 0.3), summarize the matched memories briefly and use them to answer or guide the next action.
3. If results are weak or empty, retry once with broader keywords. If still nothing useful, say so explicitly — do not fabricate context.
4. When citing a memory, mention its subject (or session id) so the user can trace it back via `evercli` or the EverMe Web UI.
5. NEVER paste the entire raw memory body verbatim if it's long; quote the salient parts only.
