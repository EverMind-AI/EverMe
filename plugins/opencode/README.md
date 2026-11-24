# @everme/opencode

EverMe long-term memory for [OpenCode](https://opencode.ai) and
[Kilo Code](https://kilo.ai) CLI, as an in-process plugin.

Kilo Code CLI is an OpenCode fork. Its plugin API and config schema are the
same, so one bundle serves both hosts.

## What it does

| Host hook | What the plugin does |
|---|---|
| `experimental.chat.system.transform` | Adds the durable Profile block to the system prompt. The plugin fetches the profile once per session. |
| `chat.message` | Fetches recall for the user's text and adds it to the message as a synthetic text part with `<everme_recall>`. |
| `event`: `session.idle` (or `session.status` idle) | Reads the session through the host's SDK client and uploads the turns that are not uploaded yet. |

The plugin skips child sessions, which the host creates for subagents.

## Install

```bash
evercli plugin install opencode    # or: evercli plugin install kilocode
```

The install does these steps:

- It stages this bundle at `<config-dir>/everme/`.
- It writes credentials to `<config-dir>/everme.env` with mode `0600`.
- It adds this element to the `plugin` array of the host's global config:
  `["<config-dir>/everme", {"envFile": "<config-dir>/everme.env", "platform": "opencode"}]`
- It keeps the read-only `mcp.everme-memory` entry, so the model can also call
  `mem_search` and `mem_context` as tools.

`<config-dir>` is `~/.config/opencode` for OpenCode and `~/.config/kilo` for
Kilo Code. The config file is `opencode.json` or `kilo.json`.

Restart the host after install. The host loads plugins only at startup.

## How a turn is read

When the session becomes idle, the plugin calls
`client.session.messages({ path: { id } })` and maps the result:

- User text parts become the user message. Synthetic and ignored parts are
  skipped, so our own recall part is never uploaded.
- Assistant text parts become assistant messages, in source order.
- A tool part becomes an assistant tool call (`callID`, `tool`, `state.input`)
  and a tool result (`state.output`, or `state.error` for a failed call).
- Reasoning, step, file, patch and compaction parts are skipped.

The plugin waits while the newest assistant message has no `time.completed`
or a tool call is still pending or running.

A per-session checkpoint stores the native ids that were uploaded, so a
repeated idle uploads nothing. The first time the plugin sees a session, it
uploads only the newest turn and records the earlier history as the excluded
baseline. A rejected upload is not committed, so the next idle retries it. An
upload that only timed out is committed, because the gateway stores the
messages before it answers.

## Configuration

The plugin reads credentials from one file. It takes the path from the first of these that has a value:

1. The `envFile` option of the `plugin` config entry.
2. `EVERME_ENV_FILE_PATH`.
3. `~/.config/opencode/everme.env`.

The option comes first because the EverMe entry and the EverOS entry run in one process and share its environment. Each entry names its own file.

`EVERME_API_BASE`, `EVERME_AGENT_ID` and `EVERME_AGENT_TOKEN` in the environment override the file. When the file sets `EVERME_BRAND` (an EverOS file), the file overrides the environment for all three.

`EVERME_STATE_DIR` moves the checkpoint directory. The plugin never writes the
token into `process.env`, because the host passes that environment to every
tool and shell command.

Without credentials the plugin does nothing.

## Uninstall

```bash
evercli plugin uninstall opencode   # or kilocode
```

To uninstall manually, do these steps:

1. In the host's config file, remove the `plugin` element whose path is
   `<config-dir>/everme` and the `mcp["everme-memory"]` entry.
2. Run `rm -rf <config-dir>/everme <config-dir>/everme.env`.
3. Restart the host.

## Tests

```bash
npm test --workspace @everme/opencode
```

## License

Apache-2.0
