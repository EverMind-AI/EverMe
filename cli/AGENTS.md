# cli/AGENTS.md (for coding Agents working in everme/cli)

- Module: `evercli` (independent go.mod)
- Stack: Go 1.25, cobra, viper, zap, govalidator, isatty
- Build: `make build` from `cli/`, or `make -C cli build` from repo root → `cli/_output/evercli`
- Test: `make test` (unit + contract)
- Dev: `cd cli && go run . <args>` (or `make dev ARGS="auth status"`)

This file is self-contained and governs `cli/` only — it references no files outside this directory.

## Command surface (post-slim)

Five subcommands, intentionally minimal:

- `auth`     — login / logout / status / me
- `plugin`   — list / install / uninstall (Claude Code, OpenClaw, Cursor, Claude Desktop, Codex, Hermes, Devin, WorkBuddy, opencode, Kimi Code, Raven)
- `import`   — conversations scan / run (cold-start session + markdown import)
- `doctor`   — slim self-checks (network reachability + credential backend)
- `skill`    — browse / install / manage EverMe skills

Binary identity is exposed via `evercli --version` (cobra-native flag).
The slimming passes also retired:
- `evercli onboard` — users run `auth login` → `plugin install` → `import conversations run` manually
- `evercli agents disconnect` — `plugin uninstall <platform>` covers the cloud disconnect; there is no standalone revoke command (Web UI remains the manual fallback)
- `evercli plugin scan` (and the post-success background scan after login/install/import) — replaced by an update-time hint: the npm wrapper's postinstall refresh (`plugins/cli/scripts/upgrade-plugins.js`) prints one line per detected host that has no EverMe entry, with the exact `evercli plugin install <platform>` command
- `evercli version` / `update` / `config` / `debug` subcommands
- `doctor --print-skills` / `--cleanup` flavors

Reintroduce any of these only with a documented user need.

## Manual install flow (replaces `onboard`)

```bash
evercli auth login                  # Device Flow; --no-wait + --device-code for AI Agents
evercli plugin install claude-code  # or `openclaw` / `dsh`; rotates evt + writes the host integration
evercli import conversations run    # cold-start session + markdown import (optional)
```

**Kimi Code is one CLI command + one TUI step** (not fully hands-off). Kimi
Code has no headless *registration* command (`/plugins install` is TUI-only)
and its `plugins/installed.json` record is an internal, manifest-embedding
format we don't hand-write. So `evercli plugin install kimicode` does the
credential + bundle work — including auto-running `npm install -g
@everme/kimicode` when the bundle isn't already on disk (mirrors claude-code;
fail-hard if npm is missing) — and the user finishes *registration* inside
Kimi Code:

```bash
evercli plugin install kimicode     # rotates evt → writes ~/.kimi-code/everme.env (0600)
                                    # + `npm install -g @everme/kimicode` if the bundle is missing
                                    # + stages the bundle (with node_modules) at ~/.kimi-code/everme/
# then, inside the Kimi Code TUI:
#   /plugins install ~/.kimi-code/everme   ← Kimi Code copies it to plugins/managed/ + writes the record
#   /plugins reload                        (or start a new session)
```

**DeepSeek Harness supports both Web and Headless through native Cordis hooks + MCP**: `evercli plugin install dsh` prefers the installed `dsh` launcher and falls back to `npx --yes @deepseek-ai/dsh@latest`, refreshes the `@everme/dsh@latest` bundle in both the `web` and `headless` profiles, writes an MCP insertion block to each profile that starts `@everme/memory-mcp@latest` through `npx`, and stores their shared credentials in `~/.dsh/.env` with mode `0600`. DSH installs receive a five-minute minimum operation budget so a cold npm fallback is not clipped by EverCLI's default 60-second command timeout. The native plugin performs automatic recall on `agent/pre-step` and saves complete turns from `session/event`; `session/flush` ensures the one-shot Headless runner waits for the upload before exiting. DSH scrubs inherited credential-shaped variables for stdio servers, so both MCP configs explicitly re-add the three EverMe variables from that env file. Restart Web sessions after install if their patch watcher has not reloaded the change; subsequent Headless runs load the updated profile directly.

**Raven is fully headless** but single-slot: `evercli plugin install raven`
drops the embedded Python backend at `~/.raven/plugins/everme-memory/` and
patches `~/.raven/config.json` (`memory.backend=everme` +
`plugins.config["everme-memory"]` credentials — Raven's config.json is its
canonical credential store, so there is no everme.env). Selecting `everme`
supersedes Raven's bundled `everos` local-memory backend for the session
(same exclusivity as OpenClaw's contextEngine slot); the pre-install config
is kept at `config.json-bak`. Requires a Raven version whose plugin registry
adds user-dir plugins to `sys.path` before factory import — older versions
discover the manifest but fail the `everme_raven` import at boot.

## Uninstall flow

`evercli plugin uninstall <platform>` performs local cleanup first and then
disconnects the cloud agent whose platform AND machine fingerprint exactly
match this machine. It never guesses: when no agent carries this machine's
fingerprint, nothing is disconnected and the result reports
`noMatchingCloudAgent` plus a NextSteps pointer at the Web UI — revoking a
fingerprint-less agent could kill another machine's token. It never deletes
an entire host config or another plugin's state. Every supported platform's
writer implements the `Remover` interface — including Hermes
(`internal/plugin/hermes.go`), which clears `memory.provider`, drops the
legacy `mcp_servers` entry, and removes `~/.hermes/plugins/everme/` +
`everme.env`. In an interactive tty the command asks a y/N confirmation
(default No) unless `--yes` is passed; `--no-prompt` requires `--yes`;
`--keep-agent` skips the cloud disconnect. There is no standalone
cloud-revoke command; disconnecting without local cleanup is a Web UI action.

If the CLI is unavailable, the manual fallback is:

1. Disconnect the agent in the EverMe web UI (account → agents → revoke).
2. Remove the host plugin entry:
   - Claude Code: `claude plugin uninstall everme && claude plugin marketplace remove everme && rm ~/.claude/everme.env`
   - OpenClaw: edit `~/.openclaw/openclaw.json` and drop everything `plugin install openclaw` wrote — `plugins.entries["@everme/openclaw"]` (the per-agent config), `plugins.slots.contextEngine` (the slot binding), and `"@everme/openclaw"` from `plugins.allow`. The plugin id mirrors `cli/internal/plugin/openclaw.go:OpenClawPluginID` — keep them in sync if it ever moves.
   - Kimi Code: in the TUI run `/plugins remove everme`, then `rm -rf ~/.kimi-code/everme ~/.kimi-code/everme.env`.
   - Raven: edit `~/.raven/config.json` — restore `memory.backend` to its previous value (see `config.json-bak`) and drop `plugins.config["everme-memory"]` — then `rm -rf ~/.raven/plugins/everme-memory`. The plugin id mirrors `cli/internal/plugin/raven.go:RavenPluginID` — keep them in sync if it ever moves.
   - DeepSeek Harness: run `dsh plugin --profile <web|headless> remove @everme/dsh` for both managed profiles, then remove only the evercli-managed blocks from each profile's `cordis.patch.yml` and from `~/.dsh/.env`; preserve every unrelated patch and env entry. If a patch becomes empty, leave `[]`; if the env file becomes empty, remove it.

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

`internal/output/` defines the AI-Agent ABI (envelope shape, exit codes, error type taxonomy). Changing field names, exit code semantics, or `error.type` values is a breaking change. Refresh the golden test fixtures in `internal/output/testdata/golden/` together with the code.

## stdout vs stderr

- **stdout**: envelope (success `data` / failure `error`) + text business output only
- **stderr**: logs, progress bars, wizard prompts, warnings, banner

Agents read stdout; humans read both. Never write log lines to stdout.
