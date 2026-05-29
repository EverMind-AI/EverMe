# cli/AGENTS.md (for coding Agents working in everme/cli)

- Module: `evercli` (independent go.mod)
- Stack: Go 1.25, cobra, viper, zap, govalidator, isatty
- Build: `make build` from `cli/`, or `make -C cli build` from repo root → `cli/_output/evercli`
- Test: `make test` (unit + contract)
- Dev: `cd cli && go run . <args>` (or `make dev ARGS="auth status"`)
- Public contract: `/docs/contracts.md`

## Command surface (post-slim)

Four subcommands, intentionally minimal:

- `auth`     — login / logout / status / me
- `plugin`   — list / install (Claude Code, OpenClaw)
- `import`   — scan / run (cold-start memory upload)
- `doctor`   — slim self-checks (network reachability + credential backend)

Binary identity is exposed via `evercli --version` (cobra-native flag).
The slimming pass also retired:
- `evercli onboard` — users run `auth login` → `plugin install` → `import run` manually
- `evercli plugin uninstall` — users disconnect agents from the EverMe web UI and clean up host plugin entries by hand
- `evercli version` / `update` / `config` / `debug` subcommands
- `doctor --print-skills` / `--cleanup` flavors

Reintroduce any of these only with a documented user need.

## Manual install flow (replaces `onboard`)

```bash
evercli auth login                  # Device Flow; --no-wait + --device-code for AI Agents
evercli plugin install claude-code  # or `openclaw`; rotates evt + writes the host plugin entry (Claude Code MCP / OpenClaw plugins.entries)
evercli import run                  # cold-start memory upload (optional)
```

## Manual uninstall flow (replaces `plugin uninstall`)

1. Disconnect the agent in the EverMe web UI (account → agents → revoke).
2. Remove the host plugin entry:
   - Claude Code: `claude plugin uninstall everme && claude plugin marketplace remove everme && rm ~/.claude/everme.env`
   - OpenClaw: edit `~/.openclaw/openclaw.json` and drop everything `plugin install openclaw` wrote — `plugins.entries["@everme/openclaw"]` (the per-agent config), `plugins.slots.contextEngine` (the slot binding), and `"@everme/openclaw"` from `plugins.allow`. The plugin id mirrors `cli/internal/plugin/openclaw.go:OpenClawPluginID` — keep them in sync if it ever moves.

## Layered import rules

```
cmd/                  → may import internal/*
internal/auth         → may import internal/{core,client,credential,output,logger,cmdutil,validate,machineid}
internal/plugin       → same
internal/importer     → same
internal/doctor       → may import internal/{core,client,credential}
internal/{core,output,client,credential,logger,machineid,cmdctx,httpmock}  → no business deps
```

Business packages (`auth`, `plugin`, `importer`) **do not import each other**; they go through infrastructure.

## Output contract is sacred

`internal/output/` defines the AI-Agent ABI (envelope shape, exit codes, error type taxonomy). Changing field names, exit code semantics, or `error.type` values is a breaking change. Update `/docs/contracts.md` together with code, and refresh golden test fixtures in `internal/output/testdata/golden/`.

## stdout vs stderr

- **stdout**: envelope (success `data` / failure `error`) + text business output only
- **stderr**: logs, progress bars, wizard prompts, warnings, banner

Agents read stdout; humans read both. Never write log lines to stdout.
