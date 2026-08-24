# Changelog

All notable changes to this repository will be documented here.

This changelog starts from the public `EverMind-AI/EverMe` repository becoming
the open-source home for EverMe CLI and agent plugins.

## [Unreleased]

### CLI

- Sync the `cli/` Go tree to the `evercli` v0.32.0 release. Earlier public
  snapshots trailed the published binaries; the tree now matches what
  `npm install -g @everme/cli` and the release archives ship.
- Add `evercli skill` — browse / install / manage EverMe skills.
- Restore `evercli plugin uninstall <platform>`: it removes only EverMe-owned
  local state (host config entry, hooks, `everme.env`) and then disconnects the
  cloud agent registered for this machine. `--keep-agent` skips the disconnect.
- Replace the flat-file import pipeline with `evercli import conversations`
  (`scan` / `run`): markdown import, an idempotency ledger scoped to one
  account and environment, and an `--async` two-phase bulk mode for cold-start
  uploads.
- Extend `evercli plugin install` past Claude Code and OpenClaw to Codex,
  Cursor, Claude Desktop, DeepSeek Harness, Devin, Hermes, Kimi Code,
  opencode, Raven, and WorkBuddy.
- Force `0600` on host config files that store an EverMe agent token.
- Stop dropping Codex tool families and non-main OpenClaw agents during import.
- Bump the `@everme/cli` npm wrapper to 0.32.0 so wrapper and binary versions
  match, and print a per-host install hint from its postinstall refresh.
- Format the tree with `gofmt` and tidy `go.mod` / `go.sum`.

- Rework `evercli plugin install hermes` to install a native Hermes
  `MemoryProvider` plugin instead of an MCP server entry. The Python provider
  is embedded in the `evercli` binary (`cli/internal/plugin/hermesassets/`)
  and scaffolded into `<hermes_home>/plugins/everme/` on install; existing
  EverMe MCP entries in `~/.hermes/config.yaml` are migrated automatically and
  credentials are preserved.
- Memory recall and writes on Hermes no longer depend on the model calling
  tools: recall runs via the provider `prefetch` hook, and writes flush
  automatically via `sync_turn`, `on_session_end`, and `on_pre_compress`
  hooks.
- Split user profile from episodic memory in the provider's memory-hub view
  so profile facts and episodes are fetched and rendered independently.
- Redact `emk_*` tokens in provider logs and error output.
- Bump `@everme/cli` to 0.2.4.
- Open-source the `evercli` Go source tree under `cli/`.
- Include CLI commands for auth, plugin install, import, and doctor workflows.
- Include CLI unit and contract tests.
- Align CLI release download references with `EverMind-AI/EverMe`.
- Fix a data race in the CLI test HTTP mock so `go test -race ./...` can be a
  reliable public quality gate.

### Plugins

- Release the protocol packages at 0.6.1 (from 0.4.2).
- Open-source four more host plugins: `@everme/kimicode`, `@everme/cursor`,
  `@everme/devin`, and `@everme/dsh` (DeepSeek Harness), each with its own test
  suite in the npm workspace.
- Refresh the Codex marketplace plugin (`plugins/everme`) to 0.6.1 so
  `codex plugin marketplace upgrade EverMind-AI/EverMe` picks up the current
  lifecycle Hook runner — the marketplace reads this repository directly, so
  the npm releases alone never reached Codex users. The bundled
  `bin/hook.mjs` is rebuilt from `plugins/codex/scripts/build-marketplace.mjs`
  and is byte-identical to the runner published on npm.
- `@everme/agent-sdk`: give lifecycle hooks a time budget that fits inside the
  host's kill deadline, and fire the watchdog after the request deadline rather
  than before it.
- Surface one trace id across plugin logs and tool results.
- Close the v2 first-flush gap so the opening turn of a session is extracted
  instead of silently dropped.

- Release the protocol packages at 0.4.2. `@everme/agent-sdk` now builds the
  recall query from the user's intent instead of the host's raw prompt
  (stripping injected reminders and host boilerplate before searching), and
  the memory MCP autonomy and extraction contracts are aligned with the
  EverMe gateway.
- Ship a self-contained Codex lifecycle Hook runner at
  `plugins/everme/bin/hook.mjs`: installed Hooks run on the host Node
  runtime (>= 18) instead of fetching `@everme/codex` through `npx` on every
  lifecycle event, and Hook commands resolve the runner through the
  `PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT` variables Codex exports. The
  marketplace plugin is bumped to 0.4.2 so `codex plugin marketplace
  add/upgrade` refreshes caches still holding the 0.4.1 payload.
- Sync `@everme/agent-sdk`, `@everme/memory-mcp`, `@everme/openclaw`,
  `@everme/claude-code`, and `@everme/codex` sources with the published
  0.4.2 packages, including the `@everme/codex` marketplace bundle build
  script, and refresh the plugins lockfile.
- Release the protocol packages at 0.4.1. `@everme/memory-mcp` regains a
  default bin (`memory-mcp`) so bare `npx -y @everme/memory-mcp@latest` — the
  command installers write into host MCP configs — resolves the stdio server
  again; 0.4.0's second bin had broken executable selection and MCP clients
  saw the connection close during the initialize handshake.
- Bump the Codex marketplace plugin (`plugins/everme`) to 0.4.1 so
  `codex plugin marketplace add/upgrade` treats the hooks-era content as a
  new version and refreshes installed caches; hook commands now pin
  `@everme/codex@0.4.1`.
- Sync `@everme/agent-sdk`, `@everme/memory-mcp`, `@everme/openclaw`, and
  `@everme/claude-code` sources with the 0.4.1 release, including the shared
  hook runtime under `agent-sdk/src/hooks/` and the memory MCP HTTP server
  binary.
- Add native Codex lifecycle hooks to the `everme` marketplace plugin:
  `plugins/everme/hooks/hooks.json` wires `SessionStart`, `UserPromptSubmit`,
  `Stop`, and `PreCompact` to the `@everme/codex` hook runner, and
  `.codex-plugin/plugin.json` now declares the `hooks` entry so
  `codex plugin marketplace add/upgrade` installs them.
- Include `@everme/codex`, the native EverMe lifecycle hook runner for Codex,
  under `plugins/codex`.
- Open-source the plugin workspace under `plugins/`.
- Include `@everme/agent-sdk`, the shared JavaScript client and helper package.
- Include `@everme/memory-mcp`, the generic MCP memory server.
- Include `@everme/claude-code`, the Claude Code native plugin.
- Include `@everme/openclaw`, the OpenClaw ContextEngine plugin.
- Include `@everme/cli`, the npm wrapper for the platform-native `evercli`
  binary.
- Include the Codex marketplace plugin under `plugins/everme`.
- Remove local release and version-bump scripts from the public repository.

### Docs

- Ship `cli/.goreleaser.yml` so the published binaries are reproducible from
  this tree, and correct its release-notes header, which still described the
  distribution as closed-source.

- Add root `README.md` and `README.zh.md`.
- Add `CONTRIBUTING.md`.
- Add `AGENTS.md` with contribution goals, pre-PR checks, source layout, and
  AI-agent output contract guidance.
- Add `docs/contracts.md` for public CLI stdout/stderr, structured errors, MCP
  tools/resources, and token redaction contracts.
- Add GitHub issue templates and a pull request template.
- Clarify that this repository contains the EverMe CLI and agent plugin code.

### CI

- Validate all ten workspace manifests in `fast-gate`, not just the original
  six.
- Exempt the import redactor and its fixtures from the private-key scan. The
  redactor exists to strip PEM blocks, so it necessarily contains the header
  pattern the scan looks for, and its fixture bodies are fabricated
  placeholders the tests assert get replaced.

- Add layered GitHub Actions CI inspired by `larksuite/cli`:
  `fast-gate`, `cli-test`, `plugin-test`, `coverage`, `package-smoke`,
  `security`, and a final `results` gate.
- Add Go build, vet, format, tidy, race-test, and coverage checks.
- Add npm workspace install, tests, audit, package manifest parsing, and wrapper
  smoke checks.

### Security

- Pin `hono`, `fast-uri`, and `ip-address` to patched floors through workspace
  `overrides`, clearing advisories that reach the tree via
  `@modelcontextprotocol/sdk`. The published package manifests are untouched —
  each pin stays inside its consumer's declared range.

- Add `SECURITY.md` with private vulnerability reporting guidance.
- Expand `.gitignore` for local env files, logs, build artifacts, Node
  dependency directories, and editor state.
- Remove copied build artifacts and dependency folders from the public tree.
- Add CI checks for generated artifacts, local env files, private key material,
  and internal repository references.
- Refresh `plugins/package-lock.json` and clear npm audit findings.
