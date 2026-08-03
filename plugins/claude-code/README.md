# EverMe — Claude Code plugin

Automatic memory recall + persistence for Claude Code, backed by the EverMe gateway.

## What it does

- **SessionStart** → loads the profile snapshot from past sessions and injects it as `additionalContext` for the model + a one-line `🧠 EverMe loaded N memory items` system message for you.
- **UserPromptSubmit** → searches your memory for content relevant to the prompt you just typed and injects it BEFORE the model sees the prompt. Silent when no relevant hit (no nag).
- **Stop** → persists the just-finished raw turn (including tool calls/results) with `flush:false`; every fifth turn triggers extraction.
- **SessionEnd** → sends a flush-only request so short sessions still extract memory without repeating messages.

Plus:

- **MCP server** exposing the canonical `mem_search` / `mem_context` / `mem_save_fact` / `mem_save_turn` tools for explicit recall and saves.
- **Slash commands** `/recall <q>` and `/everme-help`.
- **Skill** (`memory-tools`) that tells Claude when/how to use the search tool.

## Architecture (vs. the standalone `@everme/memory-mcp`)

| | `@everme/memory-mcp` (existing) | `@everme/claude-code` (this plugin) |
|---|---|---|
| Format | Generic MCP server | Claude Code plugin (hooks + commands + skill + MCP) |
| Recall trigger | User must call MCP tool manually | Automatic on every UserPromptSubmit |
| Save trigger | Explicit MCP tool call | Every Stop add + every fifth turn / SessionEnd extraction flush |
| Auth | `EVERME_AGENT_TOKEN` (evt) | Recall supports `EVERME_API_KEY` or `EVERME_AGENT_TOKEN`; realtime writes require `EVERME_AGENT_TOKEN` + `EVERME_AGENT_ID` |
| Backend | EverMe gateway (`/api/v1/mem/*`) | Same — runtime writes use `/mem/agent-memory`, not `/mem/sources` |

Both plugins share the gateway, so memory written by one is visible to the other.

## Install

```bash
./install.sh
```

The installer:

1. Verifies `claude` CLI and Node 18+ are present.
2. Prompts for `EVERME_API_KEY` (an `emk_*`) if not in the environment, persists to your shell profile.
3. Runs `claude plugin install <this-dir>` so Claude Code wires hooks + commands + MCP.

## Manual install

```bash
export EVERME_API_KEY="emk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"   # from EverMe Web UI
export EVERME_API_BASE="http://localhost:8080"                  # optional — defaults to api.everme.evermind.ai
claude plugin install /path/to/everme/plugins/claude-code
```

## Configuration

| Env var | Purpose |
|---|---|
| `EVERME_API_KEY` | Account-level emk. Supports recall-only mode. |
| `EVERME_AGENT_TOKEN` | Per-machine evt — written by `evercli plugin install claude-code`. Required for realtime writes and wins over emk when both are set. |
| `EVERME_AGENT_ID` | Required with `EVERME_AGENT_TOKEN` for realtime writes; also pins recall to a specific cloud agent. |
| `EVERME_API_BASE` | Gateway host. Defaults to `https://api.everme.evermind.ai`. Set to `http://localhost:8080` for local dev. |
| `EVERME_INJECT_TOPK` | Recall rows, default `10`, clamped to `1..20`. |
| `EVERME_INJECT_PROFILE` | `1` includes profiles in per-prompt recall; default `0` because SessionStart already injects profile. |
| `EVERME_INJECT_MIN_SCORE` | Positive-score cutoff, default `0.1`; unscored rows remain eligible. |
| `EVERME_FLUSH_EVERY_TURNS` | Extraction cadence, default `5`; `0` disables cadence flush. |
| `EVERME_FLUSH_MODE` | Set `legacy` to restore every-turn flush. |
| `EVERME_STATE_DIR` | Turn counter directory, default `~/.everme/state`; files are `0600`. |

## Verifying the install

In a new Claude Code session:

```
/everme-help
```

…should print the cheatsheet. Then:

```
/recall the postgres composite index decision
```

…should call `mem_search`, summarise hits, and cite memory subjects.

## Files

```
.claude-plugin/plugin.json           plugin metadata
.claude-plugin/marketplace.json      marketplace listing
.mcp.json                            MCP server registration
hooks/hooks.json                     SessionStart / UserPromptSubmit / Stop / SessionEnd wiring
hooks/scripts/inject-memories.js     UserPromptSubmit handler
hooks/scripts/store-memories.js      Stop handler
hooks/scripts/session-start.js       SessionStart handler
hooks/scripts/session-summary.js     SessionEnd handler
hooks/scripts/mcp-server.js          MCP server (canonical mem_* tools)
hooks/scripts/lib/adapter.js         Claude Code stdin/transcript/stdout adapter
hooks/scripts/lib/run-hook.js        thin shared-runtime entry helper
hooks/scripts/lib/config.js          Env-var resolution (emk vs evt)
hooks/scripts/lib/transcript.js      Claude Code transcript JSONL reader
commands/recall.md                   /recall slash command
commands/everme-help.md              /everme-help slash command
skills/memory-tools.md               always-injected skill — tells Claude how to use the tools
install.sh                           bash installer
```

## License

Apache-2.0
