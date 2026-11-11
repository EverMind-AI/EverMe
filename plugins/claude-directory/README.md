# EverMe memory for Claude Code

EverMe gives Claude Code a memory that lasts across sessions and machines. Before each prompt, this plugin recalls the memories that match it. After each turn, it saves the turn to your EverMe account. It has no scripts: its hooks call the EverMe MCP server directly.

## Install

```
/plugin install everme --marketplace EverMind-AI/EverMe
```

Then run `/mcp`, select `everme`, and sign in to your EverMe account in the browser. The hooks do not run until you sign in. To stop the plugin, disable it with `/plugin`.

You need an EverMe account. Create one at https://everme.evermind.ai.

## What it does

| When | What the plugin does |
|---|---|
| You submit a prompt | Searches your memory for the prompt and adds the hits to the turn as context. Saves the prompt. |
| A tool call ends or fails | Saves the tool name, its input and its result or error. |
| Claude finishes its reply | Saves the final reply and asks EverMe to extract memories from the turn. |

Claude can also call the EverMe memory tools itself: `mem_search` and `mem_context`. When you turn them on in EverMe, Claude can call the knowledge-base and connected-app tools too.

Use `/recall <topic>` to search your memory by hand.

## Data this plugin sends

The plugin sends data to one destination: the EverMe API at `https://api.everme.evermind.ai`.

While you have the plugin enabled, it sends this data for each turn of a session:

- the text of your prompt;
- for each tool call, the tool name, the full tool input and the full tool result or error. This includes shell commands and their output, and the contents of files that a tool reads;
- Claude's final reply;
- the Claude Code session id, which groups the turns of one session.

The plugin does not remove secrets from this data before it sends it. Do not use it in a session that handles credentials you do not want stored.

EverMe stores this data in your account and extracts memories from it: episodes, a profile of you, and task cases and skills. You can read, edit and delete your memories at https://everme.evermind.ai. Deleting your EverMe account deletes them.

The plugin does not save calls to the EverMe tools themselves.

Privacy policy: https://everme.evermind.ai/legal/privacy

## Limits

- The plugin does not save text that Claude writes between tool calls. It saves only the final reply.
- The plugin saves the tool calls of subagents in the session of the main conversation.
- The plugin does not add the user profile at session start. Claude reads it with `mem_context` when it needs it.

## Support

support@evermind.ai
