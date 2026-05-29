<div align="center" id="readme-top">

# EverMe

<p align="center">
  <a href="https://x.com/evermind"><img src="https://img.shields.io/badge/EverMind-000000?labelColor=gray&style=for-the-badge&logo=x&logoColor=white" alt="X"></a>
  <a href="https://discord.gg/gYep5nQRZJ"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fdiscord.com%2Fapi%2Fv10%2Finvites%2FgYep5nQRZJ%3Fwith_counts%3Dtrue&query=%24.approximate_presence_count&suffix=%20online&label=Discord&color=404EED&labelColor=gray&style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://github.com/EverMind-AI/EverMe/actions"><img src="https://img.shields.io/github/actions/workflow/status/EverMind-AI/EverMe/ci.yml?branch=main&label=CI&style=for-the-badge" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue?style=for-the-badge" alt="License"></a>
</p>

**Open-source CLI and Agent plugin suite for [EverMe](https://evermind.ai/everme) — cross-device, cross-Agent personal memory for AI Agents.**

[Product](https://evermind.ai/everme) · [Website](https://evermind.ai) · [EverOS engine](https://github.com/EverMind-AI/EverOS) · [Documentation](https://docs.evermind.ai/introduction) · [中文](README.zh.md)

</div>

<br>

<details open>
  <summary><kbd>Table of Contents</kbd></summary>

<br>

- [Project Overview](#project-overview)
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

## Project Overview

**EverMe** is your digital twin powered by a memory that's truly yours. Every conversation becomes experience; every experience becomes mastery — the Agent evolution loop.

This repository ships the **client-side toolchain** that connects any AI Agent — Claude Code, Cursor, Codex, Hermes, OpenClaw, and others — to the EverMe memory layer. The managed service and the EverOS memory engine live separately:

| Layer | What it gives you | Where it lives |
| :--- | :--- | :--- |
| **EverMe CLI + plugins** (this repo) | Auth, plugin install, MCP server, Agent hooks | `EverMind-AI/EverMe` (Apache-2.0) |
| **EverOS** memory engine | The long-term memory operating system | [EverMind-AI/EverOS](https://github.com/EverMind-AI/EverOS) (open source) |
| **EverMe managed service** | Hosted backend, account, billing | [evermind.ai/everme](https://evermind.ai/everme) |

You can run EverMe fully against the managed service today, or self-host the EverOS engine and point the CLI at your own endpoint via `EVERME_API_BASE`.

<br>

## Quick Start

### Easiest — let your Agent install it for you

Paste this single line into any AI Agent you already use locally (Claude Code, Cursor, Codex, …):

```text
Read https://everme.evermind.ai/SKILL.md and follow the instruction to install and configure EverMe.
```

The Agent fetches the skill, installs the CLI, walks you through login, and registers the plugin for itself — no manual steps.

### Manual install

```bash
# 1. Install the CLI
npm install -g @everme/cli

# 2. Authenticate (opens browser for Device Flow)
evercli auth login

# 3. Plug your Agent into EverMe — pick one or more:
evercli plugin install claude-code
evercli plugin install codex
evercli plugin install cursor
evercli plugin install hermes
evercli plugin install openclaw

# 4. Verify
evercli doctor
```

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
| [`plugins/everme/`](plugins/everme/) | Codex marketplace plugin | Codex App / Codex CLI recall via MCP resources |

<br>

## Use It With Your Agent

Each Agent has its own configuration surface. `evercli plugin install <agent>` writes the right file at the right path, with `0600` permissions for any credential-bearing config.

| Agent | Install command | What gets configured |
| :--- | :--- | :--- |
| **Claude Code** | `evercli plugin install claude-code` | `~/.claude/everme.env` + plugin registration |
| **Codex (App + CLI)** | `evercli plugin install codex` | `~/.codex/config.toml` MCP entry + marketplace plugin |
| **Cursor** | `evercli plugin install cursor` | Cursor MCP config |
| **Hermes** | `evercli plugin install hermes` | `<hermes_home>/everme.env` + `~/.hermes/config.yaml` MCP entry |
| **Claude Desktop** | `evercli plugin install claude-desktop` | Claude Desktop MCP config |
| **OpenClaw** | `evercli plugin install openclaw` | OpenClaw plugin registration |

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

EverMe is read by AI Agents as much as by humans. The stable contract for CLI stdout/stderr, structured errors, MCP tools/resources, and token redaction is documented in [`docs/contracts.md`](docs/contracts.md). Changes that break those contracts are versioned.

<br>

## Security

Do not paste API keys, `emk_*` keys, `evt_*` agent tokens, cookies, or private logs into issues or pull requests. See [`SECURITY.md`](SECURITY.md) for the private reporting path (`security@evermind.ai`).

<br>

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Bug reports, plugin support for new Agents, and additional importers are all welcome.

<br>

## License

[Apache-2.0](LICENSE). © 2026 EverMind AI.

<div align="right">

[![](https://img.shields.io/badge/-Back_to_top-gray?style=flat-square)](#readme-top)

</div>
