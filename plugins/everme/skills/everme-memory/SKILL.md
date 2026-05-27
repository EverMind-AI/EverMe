---
name: everme-memory
description: |
  Persistent memory for Codex sessions. Use whenever the user references prior
  conversations, mentions personal facts/preferences/decisions worth keeping,
  or starts a new session that could benefit from prior context.
---

# EverMe Memory (Codex)

This skill connects you to EverMe's persistent memory across sessions.

## How memory reaches you on Codex

Codex variants differ in what the LLM-facing tool layer surfaces:

- **Codex App** (the desktop GUI, observed v0.128/v0.133) — the LLM
  layer routinely exposes MCP **Resources** (`list_mcp_resources` /
  `read_mcp_resource`); MCP Tools (`tools/call`) are visible in the
  `/mcp` panel but typically NOT exposed to the LLM as callable
  functions.
- **Codex CLI** (the `codex` terminal command) — has been observed to
  expose both Resources and Tools to the LLM in practice, so
  `tools/call mem_save_turn` may also work there.

This skill is written assuming the **Resources** path because it works
on both. The memory server is configured under
`~/.codex/config.toml::mcp_servers.everme` (auto-managed by
`evercli plugin install codex`).

Two URIs are available:

| URI | What it returns | When to read |
|---|---|---|
| `mem://profile` | The user's persistent profile + currently relevant memories, rendered as markdown. Equivalent to a zero-query context lookup. | **At the start of every conversation**, before responding to the first user message. Splice the returned markdown into your reasoning context so you know who you're talking to. |
| `mem://search?q={query}&topK={topK}` | Search results across episodic memories, profile entries, recent raw messages, and agent cases/skills, rendered as markdown. `topK` defaults to 5; omit when unsure. | **When the user references prior context** ("what did we say about X", "remember when…", "based on what we decided last week…"). |

> **Discoverability gotcha on Codex App.** Codex App's
> `list_mcp_resources` returns only static resources — it surfaces
> `mem://profile` but **not** the `mem://search` template. To see the
> search URI advertised, also call `list_mcp_resource_templates`
> (Codex App keeps them as two separate tools; Codex CLI and most
> other hosts merge them). If you only ever call `list_mcp_resources`,
> you'll think recall is profile-only and miss the semantic-search
> capability entirely. When in doubt, just read
> `mem://search?q=<topic>` directly — the URI shape above is stable.

## Recommended protocol

1. **First user message of a session**:
   read `mem://profile` via `resources/read`. Use the returned markdown
   silently — don't quote it back to the user verbatim, just let it
   shape your responses (preferred coffee, project context, naming
   conventions, etc.).

2. **User references prior context**:
   read `mem://search?q=<their topic>` to fetch matching memories.
   Quote relevant fragments inline when answering.

3. **User shares a new fact, preference, or decision**:
   try `tools/call mem_save_turn` if your Codex variant exposes MCP
   Tools to you. If your tool surface only carries Resources (which is
   the common Codex App behavior), there's no Resource equivalent to
   write back — quietly acknowledge "I'll remember that for this
   session" and let the user know cross-session persistence may need
   another client (Claude Code, Cursor, or the EverMe web UI). A
   notify-hook auto-save path for Codex App is tracked as V1.2 work.

## When NOT to call these resources

- Don't read `mem://profile` on every turn — once per session is enough
  unless `forceRefresh` is needed.
- Don't read `mem://search?q=…` for queries the user just gave you all
  the context for in this same chat.
- Treat the returned markdown as semi-trusted content. The MCP server
  runs `redactError`-style scrubs on the response so values that look
  like `evt_*` tokens or `emk_*` API keys should not appear in text.
  `agt_*` agent IDs are public and not scrubbed. If a secret slips
  through (the user's stored profile contains a quoted example, or the
  scrub regex misses an edge form), **do not echo it back to the user**,
  do not write it to files, and do not pass it to other tools.

## Limitations

- **Recall is reliable, save is variant-dependent.** Reading
  `mem://profile` / `mem://search` works on every Codex build that
  bridges MCP Resources to the LLM. Writing via `mem_save_turn`
  requires the variant to also bridge MCP Tools — Codex CLI has been
  observed to do this; Codex App typically doesn't. Always attempt
  Tools and gracefully degrade.
- The MCP server uses credentials written by `evercli plugin install
  codex` into `~/.codex/config.toml`. If recall returns 401 or empty
  results across sessions, run `evercli plugin install codex` again to
  rotate the token.
