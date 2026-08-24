# @everme/dsh

Native EverMe lifecycle integration for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The Cordis plugin complements `@everme/memory-mcp`:

- `agent/pre-step` performs query-specific recall before the first model step of each turn.
- `session/event` captures the completed DSH turn, including tool calls and results, and writes it through `/mem/agent-memory`.
- `session/flush` waits for pending EverMe writes so DSH persistence checkpoints do not race the memory upload.
- Recall and save failures degrade open: DSH continues without blocking the user turn.
- The MCP server remains available through `npx -y @everme/memory-mcp@latest` for explicit `mem_context`, `mem_search`, `mem_save_fact`, and `mem_save_turn` tool calls.

## Install

Use EverCLI so the native plugin, MCP server, Cordis patch, and credentials stay in sync:

```bash
npm install -g @everme/cli
evercli auth login
evercli plugin install dsh
```

`@everme/dsh` declares a native DSH bundle. EverCLI prefers the installed `dsh` launcher and falls back to `npx --yes @deepseek-ai/dsh@latest`, refreshes the dependency in both the `web` and `headless` profiles, and configures both profiles to start `@everme/memory-mcp@latest` through `npx` at runtime. The profiles share the credentials in `~/.dsh/.env`, while EverCLI manages separate MCP blocks in `~/.dsh/profiles/web/cordis.patch.yml` and `~/.dsh/profiles/headless/cordis.patch.yml`. The DSH install flow has a five-minute minimum operation budget so the first npm download is not clipped by EverCLI's default command timeout.

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

## License

Apache-2.0.
