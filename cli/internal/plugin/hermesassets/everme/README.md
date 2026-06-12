# EverMe Memory Provider for Hermes

Native `MemoryProvider` that auto-captures every turn to EverMe and recalls
relevant context each turn — no model-initiated tool calls required.

## Install (recommended)

    npm i -g @everme/cli && evercli plugin install hermes

This writes the provider to `$HERMES_HOME/plugins/everme/`, drops credentials
into `$HERMES_HOME/everme.env` (0600), sets `memory.provider: everme` in
`config.yaml`, and removes any legacy `mcp_servers.everme` entry. Restart Hermes.

## Manual install

1. Copy this `everme/` directory to `$HERMES_HOME/plugins/everme/`.
2. Run `hermes memory setup` and choose `everme`, or set env vars:
   `EVERME_AGENT_TOKEN`, `EVERME_AGENT_ID`, `EVERME_API_BASE`.
3. Set `memory.provider: everme` in `$HERMES_HOME/config.yaml`. Restart Hermes.

## What writes where

- Every turn -> `/mem/agent-memory` (trajectories; async, non-blocking).
- Durable user facts (Hermes builtin memory writes, mirrored via `on_memory_write`; deduped per session, coalesced per burst: 10s debounce, 30s max wait, 100-fact batches) -> `/mem/personal` (profile).
- Recall -> `/mem/context` (profile, into system prompt) + `/mem/search` (per-turn prefetch).

If the backend is unreachable, writes are dropped with a log line and a circuit
breaker pauses calls for 120s — there is no fake fallback and the turn is never blocked.
