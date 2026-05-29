# evercli

EverMe cloud-memory CLI for AI Agents (Claude Code, OpenClaw, …).

> Public AI-agent contract: [`docs/contracts.md`](../docs/contracts.md).

## Build & run

```bash
make build          # → _output/evercli
make dev ARGS="--version"
make test
```

## Quickstart

```bash
evercli auth login                  # Device Flow; AI Agents pass --no-wait + --device-code
evercli plugin install claude-code  # or `openclaw`; rotates evt + writes MCP config
evercli import run                  # optional cold-start memory upload
evercli doctor                      # connectivity + credential health check
evercli --version                   # build identity
```

## Subcommand surface (post-slim, 2026-05-09)

| Command   | Purpose                                              |
|-----------|------------------------------------------------------|
| `auth`    | login / logout / status / me                         |
| `plugin`  | list / install (Claude Code, OpenClaw)               |
| `import`  | scan / run (cold-start memory upload)                |
| `doctor`  | minimal self-checks (connectivity + credential)      |

Retired in the slimming pass and replaced by the manual flow above:
`onboard`, `plugin uninstall`, `version` subcommand, `update`,
`config`, `debug bundle`. Reintroduce only on documented user need.
See [`AGENTS.md`](AGENTS.md) for the manual install / uninstall
sequences.

## Contributor notes

See [`AGENTS.md`](AGENTS.md) for module layout and import-direction rules.
