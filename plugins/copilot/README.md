# @everme/copilot

Native EverMe memory hooks for [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli).

## What it does

`evercli plugin install copilot-cli` registers four Copilot CLI hook events:

| Event | What it does |
|---|---|
| `sessionStart` | Returns the durable Profile block as `additionalContext`. |
| `userPromptSubmitted` | Returns recall for the prompt as `additionalContext`. |
| `agentStop` | Captures the finished turn and uploads it. |
| `sessionEnd` | Captures anything `agentStop` did not upload. |

The install also does these steps:

- It stages this bundle at `<config-dir>/everme/`.
- It writes credentials to `<config-dir>/everme.env` with mode `0600`.
- It writes the hook file `<config-dir>/hooks/everme.json`. Copilot CLI loads
  every `*.json` file in that directory, so evercli owns this file outright and
  never edits a hook file of the user.
- It adds the read-only `everme-memory` MCP server to
  `<config-dir>/mcp-config.json`. Other servers stay unchanged.

`<config-dir>` is `$COPILOT_HOME`, or `~/.copilot` when that is not set.

Each hook entry uses the CLI exec form (`exec` plus `args`), so no shell runs.
The config dir is passed as an argument after the event name.

Start a new Copilot CLI session after install so that it loads the hooks.

## Recall

The Copilot CLI documentation says that the output of a command hook for
`userPromptSubmitted` is dropped. The 1.0.65 changelog says that its
`additionalContext` is included in the model-facing prompt. The hook returns
recall in either case. If the host drops it, the model can still call
`mem_search` through the MCP server.

## Capture

Copilot CLI waits for every hook and has no async option. So `agentStop` and
`sessionEnd` start a detached copy of the hook script, which reads and uploads,
and return at once. The SDK holds a per-session lock, so two captures of one
session do not upload the same delta.

Capture reads `<config-dir>/session-state/<sessionId>/events.jsonl`:

- `user.message`: the text as the user typed it (`data.content`).
- `assistant.message`: the reply text and `toolRequests`.
- `tool.execution_complete`: the result text the model saw, or the error.

Capture skips these events:

- Ephemeral events, which Copilot CLI does not write to disk.
- Sub-agent events (`agentId` or `parentToolCallId`).
- Autopilot continuation prompts and prompts injected by skills or other
  agents (`data.source`).
- Events removed by `session.snapshot_rewind`.
- Tool results without a tool request in this history.
- Reasoning text.

Uploads are a delta against a native-id checkpoint, the same as
`@everme/qwenwork`. The first capture after install uploads only the newest
turn.

## Configuration

The hook reads its credentials from `<config-dir>/everme.env`, which evercli
writes. You can override the location in these ways:

- `EVERME_ENV_FILE_PATH` sets the path of the credential file.
- `EVERCLI_COPILOT_CONFIG_DIR` sets the config dir when no argument names it.

Without credentials the hooks are silent and exit with code 0.

## Uninstall

```bash
evercli plugin uninstall copilot-cli
```

To uninstall manually, do these steps:

1. Delete `<config-dir>/hooks/everme.json`.
2. In `<config-dir>/mcp-config.json`, remove the `mcpServers["everme-memory"]`
   entry. Keep every other server.
3. Run `rm -rf <config-dir>/everme <config-dir>/everme.env`.

## Tests

```bash
npm test --workspace @everme/copilot
```

The events fixture is built from the session-events schema shipped in
`@github/copilot` 1.0.104. It is not captured from a live session.

## License

Apache-2.0
