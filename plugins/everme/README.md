# EverMe for Codex

Codex marketplace plugin that pairs with the `@everme/memory-mcp` MCP server
to give Codex persistent cross-session memory **recall**.

## What you get

- **MCP resources** — `mem://profile` and `mem://search?q={query}` exposed by
  the `everme` MCP server in `~/.codex/config.toml::mcp_servers.everme`.
  Codex bridges MCP Resources to the model, so reads work end-to-end.
- **Skill** — `everme-memory`, tells Codex when to read those resources so
  recall happens without explicit prompting.

> **Write side**: the MCP server also exposes `mem_save_fact` (user
> profile facts) and `mem_save_turn` (conversation trajectories) as MCP
> Tools, but Codex's current LLM tool surface is biased toward Resources;
> automatic save from inside Codex is not guaranteed in this iteration.
> Save reliably from Claude Code, Cursor, or the EverMe web UI.

## Install

```bash
evercli plugin install codex
```

That single command:

1. Registers this marketplace via
   `codex plugin marketplace add EverMind-AI/EverMe`.
   Codex's own CLI writes `[marketplaces.everme]` into `~/.codex/config.toml`
   (carrying its `source_type` / `source` / `last_updated` fields) — evercli
   does NOT overwrite this section.
2. Calls EverMe's `POST /agents` to mint a fresh `agent_id` + `evt_*` token
   bound to your machine and `platform=codex`.
3. Upserts the `[plugins."everme@everme"]` and `[mcp_servers.everme.*]`
   sections of `~/.codex/config.toml` with the freshly-minted credentials.
   Unrelated sections are preserved verbatim.

Re-running the command rotates the token via the server-side upsert on
`(account_id, platform, machine_fingerprint)` and rewrites the config in
place — no manual cleanup, no `register` command, no copy-paste.

## Architecture note

Codex App and Codex CLI both read `~/.codex/config.toml`, so V1 ships a
single `platform=codex` (no `codex-cli` / `codex-desktop` split). One
install command, one cloud agent, one local config block.

## License

Apache-2.0.
