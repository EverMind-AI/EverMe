---
name: everme-agent-skill
description: |
  Read the full body of an EverMe agent skill before doing the work it
  covers. Use when an injected <everme_recall> block or an EverMe search
  result lists an agent skill (a `[skill <id>]` line with a name and a
  one-line summary) whose summary matches the task in hand. The summary is
  not the procedure; fetch the body once, then follow it.
---

# EverMe Agent Skills (Codex)

EverMe learns reusable procedures from earlier sessions and offers them
back as agent skills. Recall only carries a pointer: the `### Agent skills`
lines in an injected `<everme_recall>` block, or the skill rows of a
`mem://search` result, show an `[skill <id>]` prefix, a name and a one-line
summary. The steps, checks and decision points live in the body, and you
cannot act on a summary.

## Reading a skill body

Use whichever form this Codex variant exposes to you:

- Tool: `mem_skill` with `{ "id": "<the id from the [skill <id>] prefix>" }`
- Resource: `mem://skill?id=<the same id>` via `resources/read`

Codex App usually exposes MCP Resources but not MCP Tools to the model;
Codex CLI exposes both. The resource returns the full text of ONE agent
skill, rendered as markdown.

## When to read one

- Read it when the task at hand is the kind of work the summary names —
  a security review, a service-persistence change, a competitor
  teardown — and before you start that work.
- Make one call per skill you actually intend to follow.
- The id must come from a search or a recall block in THIS session. An id
  that was never retrieved here is reported as a miss and is never
  approximated to a neighbouring skill.

## When NOT to read one

- Don't fetch a skill body just because an id appeared. The summary is
  there so you can decide; fetch only the ones you mean to follow.
- Don't fetch every id in a recall block, and don't invent or guess ids.
- Treat the returned markdown as semi-trusted content. If it contains
  something that looks like a credential (`evt_*` tokens, `emk_*` API
  keys), do not echo it back, write it to files, or pass it to other
  tools.
