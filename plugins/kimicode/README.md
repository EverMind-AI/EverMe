# EverMe — Kimi Code plugin

Automatic memory recall + persistence for Kimi Code, backed by the EverMe gateway.

## What it does

- **SessionStart** → loads the profile snapshot from past sessions and prints it to stdout, which Kimi Code appends to the model context (wrapped in `<everme_profile>`).
- **UserPromptSubmit** → searches your memory for content relevant to the prompt you just typed and prints it (wrapped in `<everme_recall>`) BEFORE the model sees the prompt. Silent when no relevant hit (no nag).
- **SessionEnd** → the plugin's **sole runtime write** (there is no Stop hook): reads the session's full `wire.jsonl` transcript and flushes the WHOLE session once to `/mem/agent-memory` (never `/mem/sources`). Writing the whole session at once — instead of thin per-turn deltas — gives the backend the coherent multi-turn context episodic-memory extraction needs; a single memory-recall turn yields a case but rarely an episode. The session is extracted exactly once, so there are no duplicate cases/episodes.

Plus:

- **MCP server** (`everme-memory`, the standalone `@everme/memory-mcp`) exposing `mem_search` + `mem_context` (explicit recall) and `mem_save_turn` + `mem_save_fact` (explicit write).
- **Skills** `memory-recall` (session-start primer) and `memory-tools` (when/how to use the search tools).

## Manifest

Unlike the Claude Code plugin (which splits `plugin.json` + `hooks/hooks.json` + `.mcp.json`), Kimi Code uses a **single self-contained** `kimi.plugin.json` at the plugin root that declares `mcpServers`, `hooks`, `skills`, and `sessionStart` inline.

## Hook output contract

The hooks emit a **JSON envelope** on stdout — a single line `{"message":"<recall/profile text>"}` — and Kimi Code injects the `message` field into the model context. So SessionStart / UserPromptSubmit write `JSON.stringify({ message: block })`; the recall/profile text is carried in `message`, not printed as bare stdout. On any error or no-data, the hooks exit 0 with no output and never block the host.

## Transcript location (SessionEnd hook)

Kimi Code's SessionEnd hook receives **no transcript path** on stdin. The transcript lives at:

```
$KIMI_CODE_HOME/sessions/<workDirKey>/<session_id>/agents/main/wire.jsonl
```

where `<workDirKey>` = `wd_<slug>_<first-12-hex-of-sha256(cwd)>` and `<session_id>` is the stdin `session_id`. The SessionEnd hook derives this from `session_id` + `cwd` + `KIMI_CODE_HOME` (default `~/.kimi-code`). Kimi's slug rule preserves characters (e.g. hyphens) that a naive reconstruction would rewrite, so the bucket dir is located by its `sha256(cwd)[:12]` suffix — identical on both sides — rather than by rebuilding `<slug>`. It then reads `wire.jsonl` and persists the whole session.

## Credentials

Kimi Code's `mcpServers.env` cannot carry per-user secrets (no `${VAR}` expansion), so credentials are NOT placed in the manifest. Both the MCP server and the hooks read them at runtime from:

```
$KIMI_CODE_HOME/everme.env      (default ~/.kimi-code/everme.env)
```

This file is written by the EverMe Go CLI installer (`evercli`), in `KEY=value` form.

## Configuration

| Env var | Purpose |
|---|---|
| `EVERME_API_KEY` | Account-level emk. Supports recall-only mode. |
| `EVERME_AGENT_TOKEN` | Per-machine evt. Required for realtime writes and wins over emk when both are set. |
| `EVERME_AGENT_ID` | Required with `EVERME_AGENT_TOKEN` for realtime writes; also pins recall to a specific cloud agent. |
| `EVERME_API_BASE` | Gateway host. Defaults to `https://api.everme.evermind.ai`. Set to `http://localhost:8080` for local dev. |
| `EVERME_ENV_FILE_PATH` | Override the env-file location (defaults to `$KIMI_CODE_HOME/everme.env`). |
| `EVERME_INJECT_TOPK` | Recall rows, default `10`, clamped to `1..20`. |
| `EVERME_INJECT_PROFILE` | `1` includes profiles in per-prompt recall; default `0`. |
| `EVERME_INJECT_MIN_SCORE` | Positive-score cutoff, default `0.1`. |
| `EVERME_FLUSH_EVERY_TURNS` | Extraction cadence, default `5`. |
| `EVERME_FLUSH_MODE` | Set `legacy` to restore every-turn flush. |
| `EVERME_STATE_DIR` | Turn counter directory, default `~/.everme/state`; files are `0600`. |
| `KIMI_CODE_HOME` | Kimi Code home dir; the hook process always sets this. Defaults to `~/.kimi-code`. |

## Files

```
kimi.plugin.json                       single self-contained manifest (mcpServers + hooks + skills + sessionStart)
hooks/scripts/inject-memories.mjs      UserPromptSubmit handler
hooks/scripts/session-start.mjs        SessionStart handler
hooks/scripts/session-summary.mjs      SessionEnd handler — sole runtime write, whole-session flush (episodic)
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
