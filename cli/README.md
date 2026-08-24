# evercli

EverMe cloud-memory CLI for AI Agents (Claude Code, OpenClaw, …).

> Conventions: [`AGENTS.md`](AGENTS.md). Public AI-agent
> contract: [`docs/contracts.md`](../docs/contracts.md).

## Build & run

```bash
make build          # → _output/evercli
make dev ARGS="--version"
make test
```

## Quickstart

```bash
evercli auth login                  # Device Flow; AI Agents pass --no-wait + --device-code
evercli plugin install claude-code  # or `openclaw` / `dsh`; rotates evt + writes host config
evercli import conversations run    # optional cold-start session + markdown import
evercli doctor                      # connectivity + credential health check
evercli --version                   # build identity
```

## Subcommand surface (post-slim, 2026-05-09)

| Command   | Purpose                                              |
|-----------|------------------------------------------------------|
| `auth`    | login / logout / status / me                         |
| `plugin`  | list / install / uninstall (Claude Code, OpenClaw, Cursor, Claude Desktop, Codex, DeepSeek Harness, Hermes, Devin, WorkBuddy, opencode, Kimi Code, Raven) |
| `import`  | conversations scan / run (cold-start session + markdown import) |
| `doctor`  | minimal self-checks (connectivity + credential)      |
| `skill`   | browse / install / manage EverMe skills              |

`plugin uninstall <platform>` is back after the slimming pass: it removes
only EverMe-owned local state (config entry, hooks, everme.env) and then
disconnects the cloud agent matching this machine's fingerprint
(`--keep-agent` skips the disconnect). Devin installs land the shared MCP
entry plus a native `post_cascade_response_with_transcript` lifecycle
hook in `hooks.json` next to `~/.codeium/windsurf/mcp_config.json`. DeepSeek Harness installs add the `@everme/dsh` bundle to the Web profile for native Cordis recall/save hooks and keep `@everme/memory-mcp` available as the stdio tool server.

Still retired and replaced by the manual flow above: `onboard`,
`version` subcommand, `update`, `config`, `debug bundle`. Reintroduce
only on documented user need. See [`AGENTS.md`](AGENTS.md) for the
manual install / uninstall sequences.

## Contributor notes

See [`AGENTS.md`](AGENTS.md) for module layout and import-direction rules.
