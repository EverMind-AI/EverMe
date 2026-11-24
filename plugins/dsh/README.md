# @everme/dsh

Native EverMe lifecycle integration for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The Cordis plugin complements `@everme/memory-mcp`:

- `agent/pre-step` performs query-specific recall before the first model step of each turn. The recall is appended as a user message whose source kind is `everme` (form `snapshot`); DSH 0.1.7+ session format v4 rejects the retired `plugin` source kind.
- `session/event` captures the completed DSH turn, including tool calls and results, and writes it through `/mem/agent-memory`.
- `session/flush` waits for pending EverMe writes so DSH persistence checkpoints do not race the memory upload.
- Recall and save failures degrade open: DSH continues without blocking the user turn.
- The MCP server remains available through `npx -y @everme/memory-mcp@latest` for explicit read-only `mem_context` and `mem_search` tool calls (saving is automatic via the hooks).

## Message conversion

The native turn-end writer uses task-aware batching: preserve fitting tasks,
compress oversized tool results with 4/3/2 KiB budgets, then split only if
necessary. This does not alter the existing flush-on-turn-end contract.
Native child sessions without genuine human input are skipped at the writer.
After a native browser-authored follow-up, later assistant-only turns remain
eligible; root sessions are not subject to this child-only admission rule.

The native turn collector uses `turn/start` and `turn/end` from the session log.
Only `user/message` records whose source is `user` become human messages;
plugin context, reasoning, and control events do not become conversation text.
For native child sessions (`origin: subagent` with a v3 one-shot or continuable
descriptor), initial delegated tasks use a bare user source and are excluded.
Browser-authored follow-ups retain their native `source.rpcId` and are preserved.
This distinction does not depend on message position, text, or configurable
provider names. Root-session user messages and child assistant/tool activity
are unchanged; inherited history is not replayed as new turn content.
Trusted user text is extracted without channel-metadata pattern stripping, so
quoted Sender blocks, message IDs, and timestamps remain part of the dialogue.
Recall query cleaning is unchanged; ordinary write limits still apply.
Assistant tool-call blocks carry the provider's string ID and name. Arguments
must be a valid JSON string; the native runtime's explicit empty-string argument
form means no parameters and is encoded as `{}`. Missing fields are not filled in.
The separate `tool/call` log record is not uploaded a second time.

Tool results retain their native `toolCallId` and content array. An explicit
empty array remains one empty result; a missing content field is rejected.
Long tool results have no additional 8000-character cap. Normal text extraction,
ordinary-message limits, and the SDK's request budgets still apply. Invalid
native IDs, names, arguments, or result fields are counted in bounded diagnostics;
valid neighboring text is retained. A missing real session ID prevents the write.
When an invalid call has a unique native ID within the turn, its corresponding
result is excluded as well. Duplicate native IDs are ambiguous, so they do not
authorize guessing which result belongs to the rejected call.

Only an actual final assistant text message in a `completed` turn, without tool
calls or interruption, carries the internal completion marker. A tool can itself
conclude a native DSH turn, so `turn/end` does not authorize inventing a final
assistant message. Other assistant messages explicitly remain non-final. The
marker reaches the BFF for batching but is not sent to EverOS.

`collectTurnMessages` accepts an optional fourth logger argument for conversion
diagnostics; existing three-argument callers remain compatible. Historical
non-native object arguments, string result containers, and coerced IDs are not
part of the native DSH contract and are rejected rather than repaired.

## Install

Use EverCLI so the native plugin, MCP server, Cordis patch, and credentials stay in sync:

```bash
npm install -g @everme/cli
evercli auth login
evercli plugin install dsh
```

`@everme/dsh` declares a native DSH bundle. EverCLI prefers the installed `dsh` launcher and falls back to `npx --yes @deepseek-ai/dsh@latest`, refreshes the dependency in both the `web` and `headless` profiles, and configures both profiles to start `@everme/memory-mcp@latest` through `npx` at runtime. The profiles share the credentials in `~/.dsh/.env`, while EverCLI manages separate MCP blocks in `~/.dsh/profiles/web/cordis.patch.yml` and `~/.dsh/profiles/headless/cordis.patch.yml`. The DSH install flow has a five-minute minimum operation budget so the first npm download is not clipped by EverCLI's default command timeout.

DeepSeek Harness Desktop uses its own `desktop` profile. If the app is installed and you opened it once, EverCLI also installs `@everme/dsh` and `@everme/memory-mcp` into that profile with the CLI inside the app. That profile runs the MCP server on the app's own runtime, so a Desktop-only machine needs no Node.js. Quit the app (Cmd+Q) before you run `evercli plugin install dsh`. If the app is running, EverCLI leaves the `desktop` profile unchanged and tells you to run the command again after you quit the app. Reopen the app after the install.

Web sessions recall and save automatically after restart. Headless tasks use the same lifecycle integration and wait for pending memory writes before the one-shot process exits:

```bash
dsh --profile headless "summarize the decisions from my previous session"
```

## Cordis entry

The package exports the standard Cordis plugin surface:

```js
export const name = "everme";
export const inject = ["agents"];
export function apply(ctx, config) {}
```

Credentials are read from DSH's layered environment (`EVERME_API_BASE`, `EVERME_AGENT_ID`, and `EVERME_AGENT_TOKEN`). Do not put tokens directly in `cordis.patch.yml`.

## Where memory is kept

Without EverMe Desktop, this plugin saves memory in the EverMe cloud. To keep memory only on this Mac, install EverMe Desktop and turn on local memory. The plugin then sends memory to the local memory gateway that EverMe Desktop runs (it reads `~/.everme/memory/route.json` on each request).

Each EverMe account keeps its memory in one place: the cloud, or one Mac. If your account keeps its memory on another Mac, the cloud refuses memory from this computer, and the error names that Mac. To save memory from here, switch the account back to the cloud on that Mac, or on the web if that Mac is gone.

## License

Apache-2.0.
