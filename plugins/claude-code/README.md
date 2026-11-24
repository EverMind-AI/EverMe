# EverMe — Claude Code plugin

Automatic memory recall + persistence for Claude Code, backed by the EverMe gateway.

## What it does

- **SessionStart** → loads the profile snapshot from past sessions and injects it as `additionalContext` for the model + a one-line `🧠 EverMe loaded N memory items` system message for you.
- **UserPromptSubmit** → searches your memory for content relevant to the prompt you just typed and injects it BEFORE the model sees the prompt. Silent when no relevant hit (no nag).
- **Stop** → persists the just-finished raw turn (including tool calls/results) with `flush:false`; every fifth turn triggers extraction.
- **SubagentStop** → excludes internal task/user wrappers, then skips an independent child transcript without a real user (`subagent_without_user`). Admitted child trajectories keep their stable conversation ID and per-transcript checkpoint.
- **SessionEnd** → sends a flush-only request so short sessions still extract memory without repeating messages. Claude Code cancels a SessionEnd hook after 1.5 s (`CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`), and the flush waits for the extraction. So the hook starts a detached process to send the flush, and returns at once.

Write hooks require a nonblank native string `session_id`; `SubagentStop` also requires a nonblank native string `agent_id`. Missing or invalid IDs produce a bounded diagnostic and skip the write, without generating a fallback ID. Valid child IDs retain the `session_id__agent_id` format. Read-only recall is unaffected.

Tool arguments must encode valid JSON. Invalid calls are skipped with aggregate diagnostics, together with results whose native ID identifies that call uniquely. Other text and valid calls remain unchanged; conflicting source IDs are not used to guess result ownership. Tool result text itself need not be JSON.

Tool names must be nonblank native strings. Missing or invalid names follow the same skip-and-diagnose policy, without substituting `unknown`; an actual native tool named `unknown` remains valid.

Native assistant `message.stop_reason: "end_turn"` is retained as local batching
metadata so complete turns take priority over tool-pair boundaries. Missing or
other stop reasons do not imply completion. This metadata is not sent to the
gateway; oversized turns still use the existing tool-pair/hard-limit fallback.

Plus:

- **MCP server** exposing the read-only `mem_search` / `mem_context` / `mem_skill` tools for explicit recall (saving is automatic via the hooks). `mem_skill` reads one agent skill's full text back by the id printed in its search-result line: recall injects each skill's id and one-line summary only, and the body is cached under the shared hook state dir (`~/.everme/state`, or `EVERME_STATE_DIR`) so the MCP process can serve it without another round trip. `mem_search` accepts optional ISO 8601 `startTime` / `endTime` bounds on when the conversation happened; they compile into the gateway's `filters.timestamp` and the applied window is echoed in the result.
- **Slash commands** `/recall <q>` and `/everme-help`.
- **Skill** (`memory-tools`) that tells Claude when/how to use the search tool.

## Architecture (vs. the standalone `@everme/memory-mcp`)

| | `@everme/memory-mcp` (existing) | `@everme/claude-code` (this plugin) |
|---|---|---|
| Format | Generic MCP server | Claude Code plugin (hooks + commands + skill + MCP) |
| Recall trigger | User must call MCP tool manually | Automatic on every UserPromptSubmit |
| Save trigger | Explicit MCP tool call | Stop + SubagentStop adds; every fifth root turn / SessionEnd extraction flush |
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

## Where memory is kept

Without EverMe Desktop, this plugin saves memory in the EverMe cloud. To keep memory only on this Mac, install EverMe Desktop and turn on local memory. The plugin then sends memory to the local memory gateway that EverMe Desktop runs (it reads `~/.everme/memory/route.json` on each request).

Each EverMe account keeps its memory in one place: the cloud, or one Mac. If your account keeps its memory on another Mac, the cloud refuses memory from this computer, and the error names that Mac. To save memory from here, switch the account back to the cloud on that Mac, or on the web if that Mac is gone.

## Configuration

| Env var | Purpose |
|---|---|
| `EVERME_API_KEY` | Account-level emk. Supports recall-only mode. |
| `EVERME_AGENT_TOKEN` | Per-machine evt — written by `evercli plugin install claude-code`. Required for realtime writes and wins over emk when both are set. |
| `EVERME_AGENT_ID` | Required with `EVERME_AGENT_TOKEN` for realtime writes; also pins recall to a specific cloud agent. |
| `EVERME_API_BASE` | Gateway host. Defaults to `https://api.everme.evermind.ai`. Set to `http://localhost:8080` for local dev. |
| `EVERME_INJECT_TOPK` | Recall rows, default `5`, clamped to `1..20`. |
| `EVERME_INJECT_PROFILE` | `1` includes profiles in per-prompt recall; default `0` because SessionStart already injects profile. |
| `EVERME_INJECT_MIN_SCORE` | Positive-score cutoff, default `0.3`; unscored rows remain eligible. |
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
hooks/hooks.json                     SessionStart / UserPromptSubmit / Stop / SubagentStop / SessionEnd wiring
hooks/scripts/inject-memories.js     UserPromptSubmit handler
hooks/scripts/store-memories.js      Stop handler
hooks/scripts/store-subagent-memories.js  SubagentStop handler
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
# Task-aware ingestion

Claude Code enables the shared task-aware batching policy: preserve fitting
user tasks, compress only byte-oversized tool results with 4/3/2 KiB budgets,
then split remaining overflow at text, tool-pair, or hard boundaries. Existing
incremental reads, checkpoint commits and flush cadence are unchanged.

SubagentStop skips child transcripts without a real user after filtering,
reports `subagent_without_user`, and does not advance their checkpoints. Root
assistant-only deltas remain eligible. No Codex-specific goal envelope is
assumed for Claude's native transcript format.

## Fork history and progress

Root write hooks exclude records explicitly belonging to another native
`sessionId` before selecting messages, resolving the turn ID, and calculating
checkpoint counts or `baseTurn`. The hook's `session_id` remains authoritative.
Records without a session ID retain the existing compatibility behavior;
subagent selection is unchanged. First capture still selects only the last turn.

This corrects new-state coordinates only. Existing checkpoints and server
watermarks are not migrated or cleared; previously contaminated progress can
still skip messages and requires a separate recovery decision. No historical
replay is triggered by this change.
