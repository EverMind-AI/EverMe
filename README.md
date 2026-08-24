<div align="center" id="readme-top">

# EverMe CLI & Agent Plugins

<p align="center">
  <a href="https://x.com/evermind"><img src="https://img.shields.io/badge/EverMind-000000?labelColor=gray&style=for-the-badge&logo=x&logoColor=white" alt="X"></a>
  <a href="https://discord.gg/gYep5nQRZJ"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fdiscord.com%2Fapi%2Fv10%2Finvites%2FgYep5nQRZJ%3Fwith_counts%3Dtrue&query=%24.approximate_presence_count&suffix=%20online&label=Discord&color=404EED&labelColor=gray&style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://github.com/EverMind-AI/EverMe/actions"><img src="https://img.shields.io/github/actions/workflow/status/EverMind-AI/EverMe/ci.yml?branch=main&label=CI&style=for-the-badge" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue?style=for-the-badge" alt="License"></a>
</p>

**Open-source CLI, MCP server, SDK, and Agent plugins for connecting AI Agents to [EverMe](https://evermind.ai/everme).**

> [!IMPORTANT]
> This repository contains only the open-source EverMe client toolchain and Agent integrations. The EverMe product, web application, and managed backend are separate and are not included in this repository.

[Product](https://evermind.ai/everme) · [Website](https://evermind.ai) · [EverOS engine](https://github.com/EverMind-AI/EverOS) · [Documentation](https://docs.evermind.ai/introduction) · [中文](README.zh.md)

</div>

<br>

<details open>
  <summary><kbd>Table of Contents</kbd></summary>

<br>

- [Repository Overview](#repository-overview)
- [Quick Start](#quick-start)
- [What's Inside](#whats-inside)
- [Use It With Your Agent](#use-it-with-your-agent)
- [Architecture](#architecture)
- [Development](#development)
- [Public Contracts](#public-contracts)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

<br>

</details>

## Repository Overview

This repository ships the **client-side toolchain** that connects AI Agents — Claude Code, Cursor, Codex, Kimi Code, Hermes, Raven, OpenClaw, and others — to the [EverMe](https://evermind.ai/everme) memory layer. The managed product and the EverOS memory engine live separately:

| Layer | What it gives you | Where it lives |
| :--- | :--- | :--- |
| **EverMe CLI + plugins** (this repo) | Auth, plugin install, MCP server, Agent hooks | `EverMind-AI/EverMe` (Apache-2.0) |
| **EverOS** memory engine | The long-term memory operating system | [EverMind-AI/EverOS](https://github.com/EverMind-AI/EverOS) (open source) |
| **EverMe managed service** | Hosted backend, account, billing | [evermind.ai/everme](https://evermind.ai/everme) |

Use this toolchain with the managed EverMe service, or self-host EverOS and point the CLI at a compatible endpoint via `EVERME_API_BASE`. The hosted EverMe app, account system, and billing service are not part of this repository.

<br>

## Quick Start

### Easiest — connect your Agent in one line

Paste this single line into any AI Agent you already use locally (Claude Code, Cursor, Codex, …):

```text
Read https://everme.evermind.ai/SKILL.md and follow the instruction to install and configure EverMe.
```

The Agent fetches the skill, installs the CLI, walks you through login, and registers the plugin for itself — without requiring you to edit configuration files manually.

### Manual install

```bash
# 1. Install the CLI
npm install -g @everme/cli

# 2. Authenticate (opens browser for Device Flow)
evercli auth login

# 3. Plug your Agent into EverMe — pick one or more:
evercli plugin install claude-code
evercli plugin install claude-desktop
evercli plugin install codex
evercli plugin install cursor
evercli plugin install devin
evercli plugin install dsh
evercli plugin install hermes
evercli plugin install kimicode
evercli plugin install opencode
evercli plugin install openclaw
evercli plugin install raven
evercli plugin install workbuddy

# 4. Verify
evercli doctor
```

Kimi Code needs one final host-owned step after staging: run `/plugins install ~/.kimi-code/everme` inside its TUI. WorkBuddy asks you to trust the new MCP server in its MCP management dialog.

Once installed, open your Agent and ask "what do you remember about me?" — it will use the MCP `mem://profile` resource to recall.

> Self-hosting EverOS? Set `EVERME_API_BASE=https://your-host` before `auth login` and the CLI will talk to your endpoint instead.

<br>

## What's Inside

| Path | Package | Purpose |
| :--- | :--- | :--- |
| [`cli/`](cli/) | `evercli` | Go CLI for auth, plugin install, importers, doctor |
| [`plugins/agent-sdk/`](plugins/agent-sdk/) | `@everme/agent-sdk` | Shared HTTP client + `evt_*`/`emk_*` redaction |
| [`plugins/memory-mcp/`](plugins/memory-mcp/) | `@everme/memory-mcp` | MCP server exposing `mem://profile` and `mem://search` |
| [`plugins/claude-code/`](plugins/claude-code/) | `@everme/claude-code` | Native Claude Code plugin (hooks · commands · skills · MCP) |
| [`plugins/openclaw/`](plugins/openclaw/) | `@everme/openclaw` | OpenClaw ContextEngine plugin |
| [`plugins/cli/`](plugins/cli/) | `@everme/cli` | npm wrapper that downloads the platform-native `evercli` binary |
| [`plugins/codex/`](plugins/codex/) | `@everme/codex` | Codex lifecycle hooks and marketplace build tooling |
| [`plugins/cursor/`](plugins/cursor/) | `@everme/cursor` | Native Cursor lifecycle hooks |
| [`plugins/devin/`](plugins/devin/) | `@everme/devin` | Native Devin lifecycle hooks |
| [`plugins/dsh/`](plugins/dsh/) | `@everme/dsh` | Native DeepSeek Harness lifecycle plugin |
| [`plugins/kimicode/`](plugins/kimicode/) | `@everme/kimicode` | Native Kimi Code plugin bundle |
| [`plugins/everme/`](plugins/everme/) | Codex marketplace plugin | Codex App / Codex CLI recall via MCP resources |

<br>

## Use It With Your Agent

Each Agent has its own configuration surface. `evercli plugin install <agent>` applies the host-specific setup and protects credential-bearing files with `0600` permissions.

| Agent | Install command | What gets configured |
| :--- | :--- | :--- |
| **Claude Code** | `evercli plugin install claude-code` | `~/.claude/everme.env` + plugin registration |
| **Codex (App + CLI)** | `evercli plugin install codex` | `~/.codex/config.toml` MCP entry + marketplace plugin |
| **Cursor** | `evercli plugin install cursor` | `~/.cursor/mcp.json` + native lifecycle hooks |
| **Claude Desktop** | `evercli plugin install claude-desktop` | Claude Desktop MCP config |
| **Devin** | `evercli plugin install devin` | `~/.config/devin/mcp_config.json` + native lifecycle hooks |
| **DeepSeek Harness** | `evercli plugin install dsh` | Native lifecycle plugin + managed profile patches |
| **Hermes** | `evercli plugin install hermes` | `$HERMES_HOME/config.yaml` + embedded MemoryProvider |
| **Kimi Code** | `evercli plugin install kimicode` | Plugin bundle staging + TUI registration step |
| **OpenCode** | `evercli plugin install opencode` | `~/.config/opencode/opencode.json` MCP entry |
| **OpenClaw** | `evercli plugin install openclaw` | OpenClaw plugin registration |
| **Raven** | `evercli plugin install raven` | `~/.raven/config.json` + embedded MemoryBackend |
| **WorkBuddy** | `evercli plugin install workbuddy` | `~/.workbuddy/mcp.json` + first-connection trust step |

The memory each Agent reads and writes lives in **one shared memory pool** keyed to your account — so context follows *you*, not the app.

<br>

## Architecture

```
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  Claude Code     │    │  Codex / Cursor  │    │  Hermes / etc.   │
└────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘
         │ MCP / Hooks           │ MCP                   │ MCP
         ▼                       ▼                       ▼
   ┌───────────────────────────────────────────────────────────┐
   │  @everme/* plugins  +  evercli  (this repo)               │
   │  - mem://profile  / mem://search    (MCP resources)       │
   │  - tools: mem_save_fact, mem_save_turn, mem_context, …    │
   │  - per-agent token storage at 0600                        │
   └────────────────────────┬──────────────────────────────────┘
                            │ HTTPS + Bearer evt_*
                            ▼
   ┌───────────────────────────────────────────────────────────┐
   │  EverMe gateway  →  EverOS memory engine                  │
   │  (managed: api.everme.evermind.ai · self-host: your URL)  │
   └───────────────────────────────────────────────────────────┘
```

Memory is **global per user** (not per workspace) — multiple Agents on multiple devices share the same memory pool, with semantic search providing relevance ranking.

<br>

## Development

```bash
# CLI (Go)
cd cli
make build
make test          # go test -race ./...

# Plugin workspace (Node)
cd plugins
npm ci
npm test --workspaces --if-present
```

Release flow and packaging are documented in [`cli/README.md`](cli/README.md) and [`Makefile`](Makefile) (`make dist` builds a clean source tarball).

<br>

## Public Contracts

Humans and AI Agents both invoke this toolchain. The stable contract for CLI stdout/stderr, structured errors, MCP tools/resources, and token redaction is documented in [`docs/contracts.md`](docs/contracts.md). Changes that break those contracts are versioned.

<br>

## Security

Do not paste API keys, `emk_*` keys, `evt_*` agent tokens, cookies, or private logs into issues or pull requests. See [`SECURITY.md`](SECURITY.md) for the private reporting path (`security@evermind.ai`).

<br>

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Bug reports, plugin support for new Agents, and additional importers are all welcome.

<br>

## License

[Apache-2.0](LICENSE). This license applies only to the source code in this repository, not to the hosted EverMe product or service. © 2026 EverMind AI.

<div align="right">

[![](https://img.shields.io/badge/-Back_to_top-gray?style=flat-square)](#readme-top)

</div>
