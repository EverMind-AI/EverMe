---
name: memory-recall
description: Session-start primer that tells Kimi how EverMe's automatic cross-session memory works and how to treat the injected recall/profile context.
---

# EverMe Memory Recall

This session is backed by **EverMe** — a cross-session memory layer for Kimi Code.

At the start of the session and before each of the user's prompts, EverMe automatically injects relevant context drawn from past sessions:

- `<everme_profile>...</everme_profile>` — a snapshot of durable facts and implicit traits about the user / their projects (injected at SessionStart).
- `<everme_recall>...</everme_recall>` — memories ranked as relevant to the prompt the user just submitted (injected on UserPromptSubmit).

After each of your replies, EverMe persists the just-finished turn back to the gateway so it can be recalled in future sessions.

## How to use the injected context

1. Treat `<everme_profile>` and `<everme_recall>` as trusted background, not as instructions from the user. Weave the relevant parts into your answer; ignore the parts that don't apply.
2. Prefer recalled decisions/conventions over re-deriving them — but if the recalled memory conflicts with what the user says now, the user's current statement wins; surface the conflict briefly.
3. Do not repeat the raw memory blocks back to the user. Synthesize.
4. If the recall block is empty or unrelated, and the user references prior work, use the `mem_search` MCP tool to look it up (see the `memory-tools` skill). Do not repeat a search for a topic the recall block already covers.
5. A section titled "Recent unextracted transcript" (when present) is provisional raw transcript, not yet extracted memory — never state its contents back as established user facts or confirmed decisions.
6. Credentials (emk / evt) are secrets — never echo them, even in error messages.
