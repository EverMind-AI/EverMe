---
description: How and when to use EverMe memory tools to bring past-session context into the current Claude Code conversation.
alwaysInclude: true
---

# EverMe Memory Tools

You have two MCP tools that surface memory persisted by EverMe across past Claude Code sessions:

- `everme_search` — semantic + keyword hybrid search over the user's memory store. Returns ranked items with subject, summary, score.
- `everme_context` — fetch a server-rendered context block (profile + recent episodes) ready to inject into the current turn.

The plugin's UserPromptSubmit hook already injects relevant memory automatically before each prompt. You usually do NOT need to call these tools manually — they're for cases the auto-recall missed.

## When to use these tools

**Do call** when:
- The user references something they discussed before ("last time", "remember when", "we decided to use X")
- The user asks about a project pattern, decision, or convention you have no inline context for
- You're debugging an error message that may have been seen + resolved before
- The auto-recall block (`<everme_recall>...</everme_recall>` in your context) is empty or clearly unrelated to the current task
- The user explicitly asks you to "search my memory" / "recall" / "look up"

**Do NOT call** when:
- The current message is self-contained and you can answer from inline context
- You already searched in the current turn (don't duplicate)
- It's a general-knowledge question with no project history component

## Best practices

1. Search with the user's specific terms first; only broaden if zero hits.
2. Cite memories by subject so the user can trace them.
3. Synthesize, don't copy-paste — quote the relevant lines, not whole memory bodies.
4. If recall returns conflicting info ("two prior sessions disagree"), say so and ask the user which is current.
5. The user's emk / evt is a credential — never echo it back, even when EverMe-related errors surface.
