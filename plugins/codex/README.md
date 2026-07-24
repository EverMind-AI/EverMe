# @everme/codex

Native EverMe lifecycle hook runner for Codex. It is invoked by the EverMe
Codex marketplace plugin and uses the stable `/api/v1/mem/*` BFF contract.

## Lifecycle

- `SessionStart`: inject the EverMe profile snapshot.
- `UserPromptSubmit`: sanitize the prompt, search top 10 memories, and inject
  recall without passive profile rows by default.
- `Stop`: stream the Codex rollout, save only the latest user turn, and flush
  extraction every five turns.
- `PreCompact`: send a flush-only request.

All hook failures are fail-open and credentials are redacted from diagnostics.
`evercli plugin install codex` writes credentials to `~/.codex/everme.env`
with mode `0600`; the user reviews and trusts the commands in `/hooks`.

## Configuration

The shared hook knobs are `EVERME_INJECT_TOPK`, `EVERME_INJECT_PROFILE`,
`EVERME_INJECT_MIN_SCORE`, `EVERME_FLUSH_EVERY_TURNS`,
`EVERME_FLUSH_MODE`, and `EVERME_STATE_DIR`.

## License

Apache-2.0.
