# EverMe — Kimi Code plugin

Automatic memory recall + persistence for Kimi Code, backed by the EverMe gateway.

## What it does

- **SessionStart** → loads the profile snapshot from past sessions and prints it to stdout, which Kimi Code appends to the model context (wrapped in `<everme_profile>`).
- **UserPromptSubmit** → searches your memory for content relevant to the prompt you just typed and prints it (wrapped in `<everme_recall>`) BEFORE the model sees the prompt. Silent when no relevant hit (no nag).
- **SubagentStop** → reads completed child `agents/<agentId>/wire.jsonl` transcripts, excludes task/user wrappers, and skips independent children without a real user (`subagent_without_user`) before checkpoint access. Admitted children retain stable conversation IDs.
- **SessionEnd** → reads `agents/main/wire.jsonl` plus eligible child transcripts not yet checkpointed, applying the same child admission rule before sending to `/mem/agent-memory` (never `/mem/sources`). Task-aware batching preserves fitting user tasks; admitted child transcripts remain separate.

Plus:

- **MCP server** (`everme-memory`, the standalone `@everme/memory-mcp`) exposing read-only `mem_search` + `mem_context` + `mem_skill` (explicit recall); saving is automatic via the hooks.
- **Skills** `memory-recall` (session-start primer) and `memory-tools` (when/how to use the search tools).

## Manifest

Unlike the Claude Code plugin (which splits `plugin.json` + `hooks/hooks.json` + `.mcp.json`), Kimi Code uses a **single self-contained** `kimi.plugin.json` at the plugin root that declares `mcpServers`, `hooks`, `skills`, and `sessionStart` inline.

## Hook output contract

The hooks emit a **JSON envelope** on stdout — a single line `{"message":"<recall/profile text>"}` — and Kimi Code injects the `message` field into the model context. So SessionStart / UserPromptSubmit write `JSON.stringify({ message: block })`; the recall/profile text is carried in `message`, not printed as bare stdout. On any error or no-data, the hooks exit 0 with no output and never block the host.

## Transcript location

Kimi Code hooks receive **no transcript path** on stdin. Transcripts live at:

```
$KIMI_CODE_HOME/sessions/<workDirKey>/<session_id>/agents/<agentId>/wire.jsonl
```

where `<workDirKey>` = `wd_<slug>_<first-12-hex-of-sha256(cwd)>` and `<session_id>` is the stdin `session_id`. Hooks derive this from `session_id` + `cwd` + `KIMI_CODE_HOME` (default `~/.kimi-code`). Kimi's slug rule preserves characters (e.g. hyphens) that a naive reconstruction would rewrite, so the bucket dir is located by its `sha256(cwd)[:12]` suffix — identical on both sides — rather than by rebuilding `<slug>`. `agents/main` is the root session; every other agent directory is a child transcript.

Empty string tool results remain empty and retain their call ID; no placeholder text is added. String tool results are not subject to the cold-start importer's 8,000-character ordinary-message budget. Existing redaction and ordinary user/assistant text limits still apply.

SessionEnd retains even a single visible root message. Empty or already-uploaded
deltas are still skipped; message count is not used to predict extraction value.

Tool calls and results use the native non-empty string `toolCallId`; event
`uuid` and `parentUuid` are not substitutes. Wire `args` is the host-decoded
JSON value and is serialized once, including string and null values. Invalid
tool names are dropped along with results uniquely associated by their native
ID. Parser diagnostics report drop counts without transcript content.

Final assistant text flushed by native `finishReason: end_turn` carries internal
completion metadata for batching. A tool-driven stop without final assistant
text does not create a closing message or mark an earlier preamble complete.

## Credentials

Kimi Code's `mcpServers.env` cannot carry per-user secrets (no `${VAR}` expansion), so credentials are NOT placed in the manifest. Both the MCP server and the hooks read them at runtime from:

```
$KIMI_CODE_HOME/everme.env      (default ~/.kimi-code/everme.env)
```

This file is written by the EverMe Go CLI installer (`evercli`), in `KEY=value` form.

## Where memory is kept

Without EverMe Desktop, this plugin saves memory in the EverMe cloud. To keep memory only on this Mac, install EverMe Desktop and turn on local memory. The plugin then sends memory to the local memory gateway that EverMe Desktop runs (it reads `~/.everme/memory/route.json` on each request).

Each EverMe account keeps its memory in one place: the cloud, or one Mac. If your account keeps its memory on another Mac, the cloud refuses memory from this computer, and the error names that Mac. To save memory from here, switch the account back to the cloud on that Mac, or on the web if that Mac is gone.

## Configuration

| Env var | Purpose |
|---|---|
| `EVERME_API_KEY` | Account-level emk. Supports recall-only mode. |
| `EVERME_AGENT_TOKEN` | Per-machine evt. Required for realtime writes and wins over emk when both are set. |
| `EVERME_AGENT_ID` | Required with `EVERME_AGENT_TOKEN` for realtime writes; also pins recall to a specific cloud agent. |
| `EVERME_API_BASE` | Gateway host. Defaults to `https://api.everme.evermind.ai`. Set to `http://localhost:8080` for local dev. |
| `EVERME_ENV_FILE_PATH` | Override the env-file location (defaults to `$KIMI_CODE_HOME/everme.env`). |
| `EVERME_INJECT_TOPK` | Recall rows, default `5`, clamped to `1..20`. |
| `EVERME_INJECT_PROFILE` | `1` includes profiles in per-prompt recall; default `0`. |
| `EVERME_INJECT_MIN_SCORE` | Positive-score cutoff, default `0.3`. |
| `EVERME_FLUSH_EVERY_TURNS` | Extraction cadence, default `5`. |
| `EVERME_FLUSH_MODE` | Set `legacy` to restore every-turn flush. |
| `EVERME_STATE_DIR` | Turn counter directory, default `~/.everme/state`; files are `0600`. |
| `KIMI_CODE_HOME` | Kimi Code home dir; the hook process always sets this. Defaults to `~/.kimi-code`. |

## Files

```
kimi.plugin.json                       single self-contained manifest (mcpServers + hooks + skills + sessionStart)
hooks/scripts/inject-memories.mjs      UserPromptSubmit handler
hooks/scripts/session-start.mjs        SessionStart handler
hooks/scripts/store-subagent-memories.mjs  SubagentStop handler — checkpointed child trajectory write
hooks/scripts/session-summary.mjs      SessionEnd handler — root boundary flush plus child catch-up
hooks/scripts/lib/adapter.js           Kimi stdin/transcript/stdout adapter (readSession boundary write)
hooks/scripts/lib/run-hook.js          thin shared-runtime entry helper
hooks/scripts/lib/config.js            Env-var resolution (emk vs evt); env-file at $KIMI_CODE_HOME/everme.env
hooks/scripts/lib/kimi-transcript.js   wire.jsonl locator + parser (readSession / readLastTurn)
hooks/scripts/lib/kimi-stdin.js        snake_case stdin JSON reader
skills/memory-recall/SKILL.md          session-start primer skill
skills/memory-tools/SKILL.md           always-injected skill — when/how to use the tools
LICENSE
README.md
```

## License

Apache-2.0
## Task-aware ingestion

Stop and SessionEnd use the shared task-aware batching strategy: fitting tasks
retain original tool results; byte-oversized tasks try 4/3/2 KiB result budgets
before text/pair/hard fallback splitting. Existing flush and checkpoint paths
remain unchanged. Child sessions without real user input after filtering are
skipped with `subagent_without_user` before checkpoint access; no parent task
is copied into them. Root assistant-only records remain eligible.
