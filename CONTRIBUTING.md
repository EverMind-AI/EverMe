# Contributing

Thanks for helping improve EverMe.

## Scope

This repository accepts changes for the CLI and agent plugins:

- `cli/`
- `plugins/`
- public docs, packaging checks, and CI

## Before Opening A PR

Run the relevant checks:

```bash
cd cli
make test
go vet ./...
gofmt -l .
go mod tidy
```

```bash
cd plugins
npm ci
npm test --workspaces --if-present
```

If you change CLI output, error types, exit codes, plugin config schemas, token
storage paths, MCP tools/resources, or manifest fields, add or update
regression tests. Public CLI/MCP/redaction contracts are documented in
[docs/contracts.md](docs/contracts.md).

## Commit Style

Use Conventional Commit style:

```text
feat: add ...
fix: handle ...
docs: clarify ...
test: cover ...
chore: update ...
refactor: simplify ...
```

## Secrets

Never commit real `emk_*` keys, `evt_*` tokens, cookies, private URLs, private
logs, or production configuration. Test fixtures must use obvious dummy values.
