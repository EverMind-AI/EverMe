# EverMe agent plugins — monorepo

This directory ships **one EverMe plugin per AI-agent host**, plus a shared SDK that owns the EverMe gateway wire protocol. Each plugin iterates independently — release a Claude Code-only fix without re-publishing OpenClaw, ship a new MCP host without touching anything else.

```
plugins/
├── agent-sdk/        ← shared core (HTTP client, hook runtime, redaction, prompt helpers)
├── memory-mcp/       ← generic MCP server (local stdio + hosted Streamable HTTP)
├── openclaw/         ← OpenClaw ContextEngine plugin
├── claude-code/      ← Claude Code native plugin (hooks + commands + skill + bundled MCP)
├── kimicode/         ← Kimi Code native plugin (hooks + skills + bundled MCP; single kimi.plugin.json)
├── codex/            ← Codex native lifecycle hook runner (marketplace-distributed commands)
├── cursor/           ← Cursor native lifecycle hook runner
├── devin/            ← Devin transcript-save hook runner
├── dsh/              ← DeepSeek Harness native Cordis hooks
├── cli/              ← npm wrapper that downloads + runs the native evercli binary (independent version line)
├── package.json      ← npm workspaces root
└── scripts/
    ├── release.sh    ← topological publish (agent-sdk first, then the host plugins)
    └── bump.sh       ← keep the nine plugin packages' versions in sync (cli wrapper bumps separately)
```

The nine protocol packages (`agent-sdk` + eight host plugins) form the gateway-protocol stack described below and release together. `cli/` is a separate distribution artifact — an npm shim over the Go `evercli` binary — versioned and published on its own line; it does not depend on the SDK and is not part of the topological plugin release.

## Why one package per host

Different AI-agent hosts expose **fundamentally different plugin contracts**, not just different config files:

| Host | Plugin contract |
|---|---|
| **Claude Code** | Native plugins with hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`), slash commands, skills, marketplace |
| **Kimi Code** | Native plugin in a single self-contained `kimi.plugin.json`: `SessionStart` + `UserPromptSubmit` recall hooks, a `SessionEnd` whole-session write, skills, and a bundled MCP |
| **OpenClaw** | In-process ContextEngine module: `bootstrap → afterTurn → assemble → compact → dispose` lifecycle |
| **DeepSeek Harness** | Native Cordis events (`agent/pre-step`, `session/event`, `session/flush`) plus MCP tools |
| **Cursor / Cline / generic MCP** | External MCP server over stdio/JSON-RPC, host calls tools |
| **Cloud MCP agents** | Hosted stateless Streamable HTTP endpoint, host calls tools over HTTPS |

A single multi-host package would be a Frankenstein where every release re-versions code that didn't change, and where a Claude Code-specific hook bug forces an OpenClaw publish. Splitting per host is what飞书's CLI ecosystem (`lark-im`, `lark-doc`, `lark-base`, …) does and it scales.

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

*(`@everme/kimicode`, `@everme/codex`, `@everme/cursor`, `@everme/devin`, and `@everme/dsh` are additional native-hook packages over the same shared runtime; omitted from the diagram above for width.)*

## Host support matrix

| Host | Package | Status | Recall trigger | Save trigger |
|---|---|---|---|---|
| Claude Code | `@everme/claude-code` | ✅ | UserPromptSubmit hook (auto) | Stop + SessionEnd hooks (auto) |
| Kimi Code | `@everme/kimicode` | ✅ | UserPromptSubmit hook (auto) | SessionEnd whole-session flush (auto) |
| OpenClaw | `@everme/openclaw` | ✅ | `assemble` lifecycle (auto) | `afterTurn` lifecycle (auto) |
| Cursor | `@everme/cursor` + `@everme/memory-mcp` | ✅ native save + MCP | SessionStart profile; per-prompt MCP fallback | Stop + PreCompact hooks (auto); postToolUse spools tool calls for the Stop upload |
| Claude Desktop | `@everme/memory-mcp` | ✅ via MCP | same as Cursor | same as Cursor |
| Codex | `@everme/codex` + `@everme/memory-mcp` | ✅ native hooks + MCP | SessionStart/UserPromptSubmit hooks (auto) | Stop + PreCompact hooks (auto) |
| DeepSeek Harness | `@everme/dsh` + `@everme/memory-mcp` | ✅ native hooks + MCP | `agent/pre-step` (auto) | `turn/end` + `session/flush` (auto) |
| Hermes | native `MemoryProvider` (evercli-embedded, no npm) | ✅ native provider | `prefetch` hook (auto) | `sync_turn` + `on_session_end` / `on_pre_compress` hooks (auto) |
| Cline | `@everme/memory-mcp` | ✅ via MCP | same as Cursor | same as Cursor |
| Generic local MCP host | `@everme/memory-mcp` | ✅ via stdio MCP | same as Cursor | same as Cursor |
| Cloud MCP agent | hosted `@everme/memory-mcp` | ✅ endpoint; host smoke required | MCP tool call | MCP tool call |
| Devin | `@everme/devin` + `@everme/memory-mcp` | ✅ native save + MCP | MCP fallback | Transcript hook (auto) |
| opencode | `@everme/memory-mcp` | ✅ via MCP | same as Cursor | same as Cursor |

> One-command `evercli plugin install <host>` covers **claude-code, openclaw, cursor, claude-desktop, codex, dsh, hermes, devin, opencode**. **Kimi Code** is two-step: `evercli plugin install kimicode` stages the bundle + credentials, then you finish registration inside the TUI with `/plugins install ~/.kimi-code/everme`. Cline and generic MCP hosts also work but need manual `mcpServers` wiring — no dedicated `evercli` installer for them yet.

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
npm test --workspaces           # runs all 10 workspaces' tests (nine protocol packages + CLI wrapper)
npm test --workspace @everme/agent-sdk     # just the SDK
```

The workspace setup means edits to `agent-sdk/src/` are immediately reflected in the dependents — no `npm pack` round-trip during development.

## Release

```bash
./scripts/bump.sh patch         # 0.1.0 → 0.1.1 across the nine protocol packages
git diff && git commit -am "chore: bump to 0.1.1"
./scripts/release.sh            # dry-run preview
./scripts/release.sh --execute  # publish, agent-sdk first then dependents
```

`release.sh` enforces:

1. clean working tree (no uncommitted changes)
2. all nine protocol package versions match (the `cli` wrapper is released separately and is not checked here)
3. agent-sdk publishes BEFORE anyone who depends on it (otherwise a fresh `npm install @everme/openclaw` would 404 on the missing dep)
4. waits for the registry to acknowledge each version before moving on

## Per-host README

Each package has its own README with installation, configuration, and lifecycle:

- [`agent-sdk/README.md`](agent-sdk/README.md) — wire protocol + concurrency contracts
- [`memory-mcp/README.md`](memory-mcp/README.md) — MCP tools + host config snippet
- [`openclaw/README.md`](openclaw/README.md) — OpenClaw lifecycle + config
- [`claude-code/README.md`](claude-code/README.md) — Claude Code hooks + slash commands + skill
- [`kimicode/README.md`](kimicode/README.md) — Kimi Code hooks + skills + wire.jsonl transcript locator
- [`codex/README.md`](codex/README.md) — Codex lifecycle hook runner + rollout parser
- [`cursor/README.md`](cursor/README.md) — Cursor lifecycle hooks + recall boundary
- [`devin/README.md`](devin/README.md) — transcript-save hook
- [`dsh/README.md`](dsh/README.md) — native Cordis recall/save hooks + MCP coexistence
- [`cli/README.md`](cli/README.md) — npm wrapper install + native `evercli` binary download

## License

Apache-2.0 across all packages.
