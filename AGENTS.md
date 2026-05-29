# AGENTS.md

## Goal (pick one per PR)

- Make CLI better: improve UX, error messages, help text, flags, and output clarity.
- Improve plugin reliability: fix host integration bugs, edge cases, and regressions with tests.
- Improve developer velocity: simplify code paths, reduce complexity, keep behavior explicit.
- Improve quality gates: strengthen tests, packaging checks, and security checks without adding heavy process.

## Build & Test

```bash
cd cli && make build
cd cli && make test
cd plugins && npm ci
cd plugins && npm test --workspaces --if-present
```

## Pre-PR Checks (match CI gates)

1. `cd cli && go test ./... -count=1`
2. `cd cli && go vet ./...`
3. `cd cli && gofmt -l .` — must produce no output.
4. `cd cli && go mod tidy` — must not change `go.mod` / `go.sum`.
5. `cd plugins && npm ci`
6. `cd plugins && npm test --workspaces --if-present`
7. `cd plugins && npm audit --audit-level=moderate`
8. Verify no generated artifacts are present: `cli/_output`, `cli/dist`, `plugins/node_modules`, `*.tar.gz`, `*.zip`, `.env*`.

## Commit & PR

- Conventional Commits in English: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`.
- PR title should use the same format.
- Fill `.github/pull_request_template.md` completely.
- Never commit secrets, tokens, private URLs, internal logs, or generated build artifacts.

## Source Layout

| Path | What it does |
|------|-------------|
| `cli/cmd/` | Cobra command surface for auth, plugin install, import, and doctor. |
| `cli/internal/client/` | EverMe gateway HTTP client and envelope handling. |
| `cli/internal/output/` | CLI output contract, exit codes, and redaction. |
| `cli/internal/plugin/` | Host config writers for Codex, Claude Code, Claude Desktop, Cursor, OpenClaw, Hermes, and MCP. |
| `cli/internal/importer/` | Cold-start memory import scanning and upload flow. |
| `plugins/agent-sdk/` | Shared JavaScript client and host-agnostic helpers. |
| `plugins/memory-mcp/` | Generic MCP server for memory recall and writes. |
| `plugins/claude-code/` | Claude Code native plugin: hooks, slash commands, skill, and MCP server. |
| `plugins/openclaw/` | OpenClaw ContextEngine plugin. |
| `plugins/cli/` | npm wrapper that downloads and runs the platform-native `evercli` binary. |
| `plugins/everme/` | Codex marketplace plugin and memory skill. |

## Who Uses This Repo

EverMe's CLI and plugins are primarily used by AI agents and agent hosts. Error
messages, output envelopes, config files, and plugin manifests are read by
machines as much as by humans. Make failures structured, actionable, and
specific. The public contract is documented in [docs/contracts.md](docs/contracts.md).

## Code Conventions

### CLI output contract

`cli/internal/output/` is part of the AI-agent ABI. Do not change envelope
fields, exit code semantics, or redaction behavior without tests and updates to
[docs/contracts.md](docs/contracts.md).

### MCP contract

`plugins/memory-mcp/` exposes stable MCP tools and resources. Do not rename
`mem_context`, `mem_search`, `mem_save_turn`, `mem_save_fact`, `mem://profile`,
or `mem://search?q={query}&topK={topK}` without treating it as a breaking
change.

### stdout vs stderr

stdout is for machine-readable command output. Logs, progress, warnings, and
human hints go to stderr.

### Token handling

Full `emk_*` keys and `evt_*` tokens must never be logged, echoed to model
context, written to filenames, or shown in issue examples. Prefixes such as
`emk_a1b2` and `evt_a1b2` are acceptable when intentionally surfaced.

### Tests

Every behavior change needs a test alongside the change. Host config writers,
manifest changes, token storage paths, and MCP tool/resource contracts should
have regression tests.
