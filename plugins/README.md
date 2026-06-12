# EverMe agent plugins — monorepo

This directory ships **one EverMe plugin per AI-agent host**, plus a shared SDK that owns the EverMe gateway wire protocol. Each plugin can evolve independently so host-specific changes stay scoped.

```
plugins/
├── agent-sdk/        ← shared core (HTTP client, presign+S3 upload, buffer, redaction, prompt helpers)
├── memory-mcp/       ← generic MCP server (Cursor / Cline / any MCP host)
├── openclaw/         ← OpenClaw ContextEngine plugin
├── claude-code/      ← Claude Code native plugin (hooks + commands + skill + bundled MCP)
└── package.json      ← npm workspaces root
```

## Why one package per host

Different AI-agent hosts expose **fundamentally different plugin contracts**, not just different config files:

| Host | Plugin contract |
|---|---|
| **Claude Code** | Native plugins with hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`), slash commands, skills, marketplace |
| **OpenClaw** | In-process ContextEngine module: `bootstrap → afterTurn → assemble → compact → dispose` lifecycle |
| **Cursor / Cline / generic MCP** | External MCP server over stdio/JSON-RPC, host calls tools |

A single multi-host package would couple unrelated host integrations, and a Claude Code-specific hook bug would force OpenClaw users to absorb an unrelated package update. Splitting per host is what Feishu's CLI ecosystem (`lark-im`, `lark-doc`, `lark-base`, ...) does and it scales.

## Architecture

```
                       ┌────────────────────┐
                       │ EverMe gateway     │
                       │ /api/v1/mem/*      │
                       └─────────▲──────────┘
                                 │ HTTP envelope
                       ┌─────────┴──────────┐
                       │ @everme/agent-sdk  │  ← shared lib (host-agnostic)
                       │  client / upload / │
                       │  buffer / search / │
                       │  redact / prompt   │
                       └──┬──────┬───────┬──┘
            depends on    │      │       │
              ┌───────────┘      │       └──────────┐
              ▼                  ▼                  ▼
   ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
   │ @everme/        │  │ @everme/        │  │ @everme/        │
   │   memory-mcp    │  │   openclaw      │  │   claude-code   │
   │ (MCP server)    │  │ (ContextEngine) │  │ (native plugin) │
   └─────────────────┘  └─────────────────┘  └─────────────────┘
              │                  │                  │
              ▼                  ▼                  ▼
        Cursor / Cline       OpenClaw          Claude Code
        / generic MCP        (in-process)       (hooks + cmds + MCP)
```

## Host support matrix

| Host | Package | Status | Recall trigger | Save trigger |
|---|---|---|---|---|
| Claude Code | `@everme/claude-code` | ✅ | UserPromptSubmit hook (auto) | Stop + SessionEnd hooks (auto) |
| OpenClaw | `@everme/openclaw` | ✅ | `assemble` lifecycle (auto) | `afterTurn` lifecycle (auto) |
| Cursor | `@everme/memory-mcp` | ✅ via MCP | model-driven (`mem_search` tool) | model-driven (`mem_save_turn` tool; SDK-side `buffer.flush()` on session end) |
| Claude Desktop | `@everme/memory-mcp` | ✅ via MCP | same as Cursor | same as Cursor |
| Codex | `@everme/memory-mcp` | ✅ via MCP (CLI) / Resources (App) | model-driven (`mem_search` tool / `mem://search`) | model-driven (`mem_save_turn`; Codex App is recall-only) |
| Hermes | native `MemoryProvider` (evercli-embedded, no npm) | ✅ native provider | `prefetch` hook (auto) | `sync_turn` + `on_session_end` / `on_pre_compress` hooks (auto) |
| Cline | `@everme/memory-mcp` | ✅ via MCP | same as Cursor | same as Cursor |
| Generic MCP host | `@everme/memory-mcp` | ✅ via MCP | same as Cursor | same as Cursor |
| Gemini CLI | `@everme/memory-mcp` | ✅ via MCP | same as Cursor | same as Cursor |
| opencode | `@everme/memory-mcp` | ✅ via MCP | same as Cursor | same as Cursor |

> One-command `evercli plugin install <host>` covers **claude-code, openclaw, cursor, claude-desktop, codex, hermes, gemini, opencode**. Cline and generic MCP hosts also work but need manual `mcpServers` wiring — no dedicated `evercli` installer for them yet.

### Roadmap

| Host | Plan | Why |
|---|---|---|
| Continue.dev | `@everme/continue` if Continue grows a per-plugin hook API beyond MCP | They currently rely on context providers — different contract from MCP |
| JetBrains AI | `@everme/jetbrains` | JetBrains has its own plugin SDK; needs Kotlin/Java glue |
| Aider | TBD | Look at whether their lifecycle hooks are first-class enough |
| VS Code Copilot | Out of scope | Copilot doesn't expose a plugin/MCP surface |

When a new host's plugin contract justifies its own package, we add a sibling here. Until then we route through `@everme/memory-mcp` if the host speaks MCP, or skip if it doesn't.

## Develop

```bash
cd everme/plugins
npm install                     # symlinks @everme/agent-sdk into all dependents
npm test --workspaces           # runs all 5 workspaces' tests (137 total)
npm test --workspace @everme/agent-sdk     # just the SDK
```

The workspace setup means edits to `agent-sdk/src/` are immediately reflected in the dependents — no `npm pack` round-trip during development.

## Per-host README

Each package has its own README with installation, configuration, and lifecycle:

- [`../docs/contracts.md`](../docs/contracts.md) — public CLI/MCP/token redaction contract
- [`agent-sdk/README.md`](agent-sdk/README.md) — wire protocol + concurrency contracts
- [`memory-mcp/README.md`](memory-mcp/README.md) — MCP tools + host config snippet
- [`openclaw/README.md`](openclaw/README.md) — OpenClaw lifecycle + config
- [`claude-code/README.md`](claude-code/README.md) — Claude Code hooks + slash commands + skill

## License

Apache-2.0 across all packages.
