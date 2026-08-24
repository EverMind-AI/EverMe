---
name: memory-tools
description: Use EverMe memory proactively when the user refers to previous conversations, earlier decisions, "last time", "remember when", existing project conventions, or previously solved errors, and save durable user preferences, habits, and decisions the moment they are stated. Do not repeat a search when a non-empty <everme_recall> block already exists.
alwaysInclude: true
---

# EverMe Memory Tools

You have four MCP tools (from the `everme-memory` MCP server) for memory EverMe persists across past Kimi Code sessions.

Recall:
- `mem_search` — semantic + keyword hybrid search over the user's memory store (episodic, profile, agent cases/skills, recent raw transcript). Rows under "Recent unextracted transcript" are provisional, not established facts.
- `mem_context` — the user's durable Profile snapshot ONLY. It never searches and never returns episodes; do not use it to recall past decisions or task context.

Write:
- `mem_save_fact` — save a durable user fact (preference, habit, trait, long-term decision). Call it proactively the moment the user states one — do NOT wait for the user to say "remember this". Only `extracted: true` / `profileUpdated: true` in the result means the profile really updated; on `no_extraction` say so plainly, do not auto-retry, and do not claim success.
- `mem_save_turn` — persist a complete task trajectory worth reusing (rarely needed given the automatic SessionEnd write). Chat-dual-write backends may also update the user's Profile; check `profileUpdated`. Use `mem_save_fact` for a deliberate durable fact.

The plugin's UserPromptSubmit hook already injects relevant memory automatically before each prompt (wrapped in `<everme_recall>...</everme_recall>`); native hooks also save the session automatically. When native recall exists and is relevant, do not duplicate it; when it is missing and the task depends on history, call the tools proactively.

## When to use these tools

**Do call** when:
- The `<everme_recall>` block is missing, empty, or clearly unrelated AND the user references something discussed before ("last time", "remember when", "we decided to use X", "continue where we left off")
- The user asks about a project pattern, decision, or convention you have no inline context for
- You're debugging an error message that may have been seen + resolved before
- The user explicitly asks you to "search my memory" / "recall" / "look up"
- The user states a durable fact about themselves — call `mem_save_fact` even without being asked

**Do NOT call** when:
- This turn already carries a non-empty, relevant `<everme_recall>` block covering the topic
- You already searched with the same query in the current turn (don't duplicate)
- The current message is self-contained and you can answer from inline context
- It's a general-knowledge question with no project history component

## Best practices

1. Search with the user's specific terms first; only broaden if zero hits.
2. Cite memories by subject so the user can trace them.
3. Synthesize, don't copy-paste — quote the relevant lines, not whole memory bodies.
4. If recall returns conflicting info ("two prior sessions disagree"), say so and ask the user which is current.
5. The user's emk / evt is a credential — never echo it back, even when EverMe-related errors surface.
