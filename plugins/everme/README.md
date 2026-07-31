# EverMe for Codex

Codex marketplace plugin that combines native lifecycle hooks with the
`@everme/memory-mcp` MCP server for persistent cross-session memory.

## What you get

- **MCP resources** — `mem://profile` and `mem://search?q={query}` exposed by
  the `everme` MCP server in `~/.codex/config.toml::mcp_servers.everme`.
  Codex bridges MCP Resources to the model, so reads work end-to-end.
- **Skill** — `everme-memory`, tells Codex when to read those resources so
  recall happens without explicit prompting.
- **Native hooks** — SessionStart loads the profile, UserPromptSubmit recalls
  relevant memory, Stop saves the latest turn, and PreCompact flushes pending
  extraction. Hook failures are non-blocking and redact credentials.

## Install

```bash
evercli plugin install codex
```

That single command:

1. Finds either the standalone `codex` CLI or the binary bundled with the
   macOS ChatGPT/Codex desktop app, then registers this marketplace via
   `codex plugin marketplace add EverMind-AI/EverMe`.
   Codex's own CLI writes `[marketplaces.everme]` into `~/.codex/config.toml`
   (carrying its `source_type` / `source` / `last_updated` fields) — evercli
   does NOT overwrite this section.
2. Runs `codex plugin add everme@everme --json` and verifies the returned
   plugin cache contains `hooks/hooks.json` and the bundled `bin/hook.mjs`.
3. Calls EverMe's `POST /agents` to mint a fresh `agent_id` + `evt_*` token
   bound to your machine and `platform=codex`.
4. Upserts the `[plugins."everme@everme"]` and `[mcp_servers.everme.*]`
   sections of `~/.codex/config.toml` with the freshly-minted credentials.
   Unrelated sections are preserved verbatim.
5. Writes the same hook credentials to `~/.codex/everme.env` with mode `0600`.

Start a new Codex session after installation, open `/hooks`, and review and
trust the EverMe hook commands. A changed hook command requires trust again.
The marketplace ships a self-contained Hook runner, so execution never installs
a package or downloads `@everme/codex` through `npx`; it only needs a Node
runtime (>= 18) resolvable on the session `PATH`. Codex runs a hook command
through a shell with the session working directory as its cwd, so the commands
in `hooks/hooks.json` locate the runner through the `PLUGIN_ROOT` /
`CLAUDE_PLUGIN_ROOT` variables Codex exports rather than through a cwd-relative
path.

Re-running the command rotates the token via the server-side upsert on
`(account_id, platform, machine_fingerprint)` and rewrites the config in
place — no manual cleanup, no `register` command, no copy-paste.

## Architecture note

Codex App and Codex CLI both read `~/.codex/config.toml`, so V1 ships a
single `platform=codex` (no `codex-cli` / `codex-desktop` split). One
install command, one cloud agent, one MCP config, and one protected hook env
file. Plugins continue to call the stable `/api/v1/mem/*` BFF contract; cloud
memory implementation selection stays server-side.

## License

Apache-2.0.
