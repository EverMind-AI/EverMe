# @everme/devin

Native EverMe lifecycle hook runner for Devin. It keeps memory
traffic on EverMe's stable `/api/v1/mem/*` BFF contract.

## Lifecycle

Devin Desktop 3.9.19 (2026-09-08) removed the Cascade agent. Devin Local is
now its only agent, and Devin Local runs Claude Code-shaped hooks. The hook
handles these Devin Local events:

- `SessionStart`: returns the EverMe profile as
  `hookSpecificOutput.additionalContext`.
- `UserPromptSubmit`: stores the prompt under its `session_id` and
  `prompt_id`, then returns recall as `hookSpecificOutput.additionalContext`.
- `Stop`: starts a detached worker and exits. The worker pairs
  `last_assistant_message` with the prompt of the same `prompt_id` and saves
  the pair as one turn. Devin waits for `Stop` hooks, so the upload does not
  run in the hook process. A second `Stop` for the same `prompt_id` does not
  save the turn again.

The Stop payload goes to the worker through an owner-only (`0600`) file in the
hook state directory. The worker reads the file once and deletes it.

On Devin Desktop 3.14.30819 (2026-11-18), a probe confirmed these facts:

- Devin Local fired the three events from `~/.config/devin/config.json`.
- `Stop` carried `last_assistant_message`, which the Devin docs do not list.
- The model received the `additionalContext` of both `SessionStart` and
  `UserPromptSubmit`.

### Cascade events

The hook still handles the Cascade events for a Devin older than 3.9.19:

- `pre_user_prompt`: keep the real user prompt and native hook timestamp until
  the inline response arrives. Empty answers do not discard this user message.
- `post_cascade_response`: keep the nonempty native response summary and its
  timestamp. A summary is not assumed to be a final assistant answer.
- `post_run_command` / `post_read_code`: skip with a fixed diagnostic. These
  Cascade events supply no native call ID or result; `execution_id` is a turn ID.
- `post_cascade_response_with_transcript`: stream the protected JSONL
  transcript and save only the latest user input plus following planner
  responses, or planner responses when no user step is present. Empty user
  steps still delimit turns. Rule metadata is not imported as user content.

The transcript parser excludes code actions without reconstructing missing
tool identity or results. Unsupported steps and malformed JSON produce fixed
reason/count diagnostics, at most three lines per transcript read; source
types, paths, content, and credentials are not printed. Known user and planner
text is unchanged.

## Install

All hook failures are fail-open and credentials are redacted from diagnostics.
`evercli plugin install devin` writes these files:

- `~/.config/devin/everme.env`: credentials, mode `0600`.
- `~/.config/devin/mcp_config.json`: the `everme-memory` MCP server.
- `~/.config/devin/config.json`: one EverMe hook group for each of
  `SessionStart`, `UserPromptSubmit` and `Stop`, under the `hooks` key. Other
  keys and other hook groups in the file are kept.

Install also removes the EverMe entries that a Cascade-era install left in
`~/.codeium/windsurf/` (`hooks.json`, `mcp_config.json` and `everme.env`).
Devin 3.14 imports hooks and MCP servers from that directory, so an old entry
would run beside the new install with a revoked token.

An install made before this change does not register the Devin Local events.
Run `evercli plugin install devin` again to get capture and recall on Devin
3.9.19 or later.

## Where memory is kept

Without EverMe Desktop, this plugin saves memory in the EverMe cloud. To keep memory only on this Mac, install EverMe Desktop and turn on local memory. The plugin then sends memory to the local memory gateway that EverMe Desktop runs (it reads `~/.everme/memory/route.json` on each request).

Each EverMe account keeps its memory in one place: the cloud, or one Mac. If your account keeps its memory on another Mac, the cloud refuses memory from this computer, and the error names that Mac. To save memory from here, switch the account back to the cloud on that Mac, or on the web if that Mac is gone.

## Configuration

Response writes use shared task-aware batching. Complete fitting tasks are
preserved, and tool results are compressed only when the task exceeds the
byte budget. Native events without tool IDs still cannot create tool pairs.

The shared hook knobs are `EVERME_FLUSH_EVERY_TURNS`, `EVERME_FLUSH_MODE`, and
`EVERME_STATE_DIR`.

## License

Apache-2.0.
