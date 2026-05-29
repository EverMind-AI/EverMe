# EverMe

EverMe is the open-source CLI and plugin layer for connecting AI agents to
persistent memory. This repository contains the local tools and agent
integrations that let agent hosts recall and save memory.

## What Is In This Repo

```text
cli/       Go source for the evercli command
plugins/   Agent plugins, MCP server, npm wrapper, and shared SDK
```

## Packages

| Path | Package | Purpose |
|---|---|---|
| `cli/` | `evercli` | Login, plugin install, import, and diagnostics. |
| `plugins/agent-sdk/` | `@everme/agent-sdk` | Shared JavaScript client for EverMe agent plugins. |
| `plugins/memory-mcp/` | `@everme/memory-mcp` | Generic MCP server for memory recall and writes. |
| `plugins/claude-code/` | `@everme/claude-code` | Claude Code native plugin with hooks, commands, skill, and MCP. |
| `plugins/openclaw/` | `@everme/openclaw` | OpenClaw ContextEngine plugin. |
| `plugins/cli/` | `@everme/cli` | npm wrapper that downloads and runs the `evercli` binary. |
| `plugins/everme/` | Codex plugin | Codex marketplace plugin for EverMe recall. |

## Quickstart

Install the CLI:

```bash
npm install -g @everme/cli
evercli --help
```

Typical flow:

```bash
evercli auth login
evercli plugin install codex
evercli plugin install claude-code
evercli doctor
```

## Development

Build and test the Go CLI:

```bash
cd cli
make build
make test
```

Test the plugin workspace:

```bash
cd plugins
npm ci
npm test --workspaces --if-present
```

## Public Contracts

EverMe is read by AI agents as much as humans. The public contract for CLI
stdout/stderr, structured errors, MCP tools/resources, and token redaction is
documented in [docs/contracts.md](docs/contracts.md).

## Security

Do not paste API keys, `emk_*` keys, `evt_*` agent tokens, cookies, or private
logs into issues or pull requests. See [SECURITY.md](SECURITY.md) for the
private reporting path.

## License

Apache-2.0.
