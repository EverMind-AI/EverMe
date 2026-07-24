---
name: everme-memory
description: |
  Persistent memory for Codex sessions with native lifecycle recall and save.
  Use MCP resources and tools when explicit memory operations are needed.
---

# EverMe Memory (Codex)

This skill connects you to EverMe's persistent memory across sessions.

## How memory reaches you on Codex

EverMe lifecycle hooks work independently of the model-facing tool surface:

- `SessionStart` injects the user's profile.
- `UserPromptSubmit` searches and injects relevant memory.
- `Stop` saves the latest completed turn and flushes every five turns.
- `PreCompact` flushes pending extraction before compaction.

These hooks are fail-open: a memory backend error never blocks Codex. The MCP
server remains available for explicit reads and writes chosen by the model.

Codex variants differ in what the LLM-facing tool layer surfaces:

- **Codex App** (the desktop GUI, observed v0.128/v0.133) — the LLM
  layer routinely exposes MCP **Resources** (`list_mcp_resources` /
  `read_mcp_resource`); MCP Tools (`tools/call`) are visible in the
  `/mcp` panel but typically NOT exposed to the LLM as callable
  functions.
- **Codex CLI** (the `codex` terminal command) — has been observed to
  expose both Resources and Tools to the LLM in practice, so
  `tools/call mem_save_turn` may also work there.

The memory server is configured under
`~/.codex/config.toml::mcp_servers.everme` (auto-managed by
`evercli plugin install codex`).

Two URIs are available:

| URI | What it returns | When to read |
|---|---|---|
| `mem://profile` | The user's persistent profile + currently relevant memories, rendered as markdown. Equivalent to a zero-query context lookup. | **At the start of every conversation**, before responding to the first user message. Splice the returned markdown into your reasoning context so you know who you're talking to. |
| `mem://search?q={query}&topK={topK}` | Search results across episodic memories, profile entries, recent raw messages, and agent cases/skills, rendered as markdown. Keep `q` **short** — a few keywords or one short phrase, not a long passage; `topK` defaults to 10, omit it. | **When the user references prior context** ("what did we say about X", "remember when…", "based on what we decided last week…"). |

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

Native hooks already perform routine profile load, recall, and turn capture.
Use these explicit MCP operations only when they add value:

1. **A fresh profile is explicitly needed**:
   read `mem://profile` via `resources/read`. Do not repeat this every turn;
   SessionStart already injects the normal snapshot.

2. **User asks for broader or refreshed prior context**:
   read `mem://search?q=<their topic>` to fetch matching memories. Keep
   `q` short — a few keywords or one short phrase naming the topic. Quote
   relevant fragments inline when answering.

3. **A durable fact should be saved immediately**:
   if your Codex variant exposes MCP Tools (Codex CLI typically does),
   call `tools/call mem_save_fact` with that fact — it writes the user's
   long-term profile (the block loaded at session start). Use
   `tools/call mem_save_turn` instead when you want to record the
   conversation trajectory (how a task was solved), not a profile fact.
   Normal completed turns are already captured by Stop.

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

- Explicit MCP writes remain variant-dependent because the host must expose
  MCP Tools. Native hook turn capture does not depend on MCP Tool exposure.
- Hooks run only after the user reviews and trusts them in `/hooks`.
- The MCP server uses credentials written by `evercli plugin install
  codex` into `~/.codex/config.toml`. If recall returns 401 or empty
  results across sessions, run `evercli plugin install codex` again to
  rotate the token.
