# @everme/devin

Native EverMe lifecycle hook runner for Devin. It keeps memory
traffic on EverMe's stable `/api/v1/mem/*` BFF contract.

## Lifecycle

- `post_cascade_response_with_transcript`: stream the protected JSONL
  transcript and save only the latest user input plus following planner
  responses.

The parser ignores code actions, file bodies, command output, unknown steps,
and malformed lines. Devin's current `pre_user_prompt` hook can allow or
block a prompt but cannot inject hidden model context, so per-prompt recall
remains available through the `everme-memory` MCP tools.

All hook failures are fail-open and credentials are redacted from diagnostics.
`evercli plugin install devin` writes credentials to
`~/.codeium/windsurf/everme.env` with mode `0600`, merges the MCP server into
`~/.codeium/windsurf/mcp_config.json`, and writes the lifecycle hook to
`~/.codeium/windsurf/hooks.json`. Devin Desktop still uses this internal
Cascade directory after the product rename; `~/.config/devin/config.json`
belongs to the separate Devin terminal CLI.

## Configuration

The shared hook knobs are `EVERME_FLUSH_EVERY_TURNS`, `EVERME_FLUSH_MODE`, and
`EVERME_STATE_DIR`.

## License

Apache-2.0.
