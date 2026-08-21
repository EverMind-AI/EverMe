# EverMe memory backend for Raven

External user-dir plugin implementing Raven's `MemoryBackend` Protocol
(`raven.memory_engine.backend`) against the EverMe cloud `/mem` BFF.
Installed by `evercli plugin install raven` into
`~/.raven/plugins/everme-memory/` and activated via
`memory.backend = "everme"` in `~/.raven/config.json`.

## Layout

- `raven-plugin.toml` — Raven plugin manifest; contributes the `everme`
  memory backend via `everme_raven.backend:make_backend`.
- `everme_raven/backend.py` — `MemoryBackend` implementation
  (`start` / `stop` / `recall` / `store` / `feedback`).
- `everme_raven/client.py` — stdlib-only HTTP client (Bearer evt auth,
  envelope parsing, GET-only retry, token redaction). Verbatim port of
  the Hermes provider's client.
- `everme_raven/config.py` — config resolution: plugin config dict >
  `EVERME_*` env vars > defaults.

## Endpoint mapping

| MemoryBackend | EverMe BFF |
|---|---|
| `recall()` | `POST /api/v1/mem/search`; user track prepends the profile block warmed from `POST /api/v1/mem/context` at `start()` |
| `store()` | `POST /api/v1/mem/agent-memory` (epoch-ms timestamps, `toolCalls` preserved, `flush` every `flush_every_turns`) |
| `feedback()` | no EverMe sink yet — logged once, dropped |

Selecting `memory.backend = "everme"` replaces the bundled `everos`
backend for the session (Raven's memory slot is single-choice); Raven's
own MEMORY.md / consolidation pipeline is unaffected.

## Config (`plugins.config["everme-memory"]`)

| key | default | notes |
|---|---|---|
| `api_base` | `https://api.everme.evermind.ai` | `/api/v1` suffix appended automatically |
| `agent_id` | — | `agt_...`, written by evercli |
| `agent_token` | — | `evt_...` plaintext, minted at install; required |
| `flush_every_turns` | `1` | `0` disables flushing |
| `timeout_s` | `30.0` | per-request timeout |

## Tests

```bash
cd cli/internal/plugin/ravenassets/tests && python3 -m unittest discover
```

No Raven install needed — `_fakes.py` stubs `raven.memory_engine`.
