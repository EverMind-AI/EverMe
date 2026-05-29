# Changelog

All notable changes to this repository will be documented here.

This changelog starts from the public `EverMind-AI/EverMe` repository becoming
the open-source home for EverMe CLI and agent plugins.

## [Unreleased]

### CLI

- Open-source the `evercli` Go source tree under `cli/`.
- Include CLI commands for auth, plugin install, import, and doctor workflows.
- Include CLI unit and contract tests.
- Align CLI release download references with `EverMind-AI/EverMe`.
- Fix a data race in the CLI test HTTP mock so `go test -race ./...` can be a
  reliable public quality gate.

### Plugins

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

- Add root `README.md` and `README.zh.md`.
- Add `CONTRIBUTING.md`.
- Add `AGENTS.md` with contribution goals, pre-PR checks, source layout, and
  AI-agent output contract guidance.
- Add `docs/contracts.md` for public CLI stdout/stderr, structured errors, MCP
  tools/resources, and token redaction contracts.
- Add GitHub issue templates and a pull request template.
- Clarify that this repository contains the EverMe CLI and agent plugin code.

### CI

- Add layered GitHub Actions CI inspired by `larksuite/cli`:
  `fast-gate`, `cli-test`, `plugin-test`, `coverage`, `package-smoke`,
  `security`, and a final `results` gate.
- Add Go build, vet, format, tidy, race-test, and coverage checks.
- Add npm workspace install, tests, audit, package manifest parsing, and wrapper
  smoke checks.

### Security

- Add `SECURITY.md` with private vulnerability reporting guidance.
- Expand `.gitignore` for local env files, logs, build artifacts, Node
  dependency directories, and editor state.
- Remove copied build artifacts and dependency folders from the public tree.
- Add CI checks for generated artifacts, local env files, private key material,
  and internal repository references.
- Refresh `plugins/package-lock.json` and clear npm audit findings.
