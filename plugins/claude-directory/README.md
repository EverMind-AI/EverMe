# EverMe memory for Claude Code

EverMe gives Claude Code a memory that lasts across sessions and machines. Before each prompt, this plugin recalls the memories that match it. After each turn, it saves the turn to your EverMe account. It has no scripts: its hooks call the EverMe MCP server directly.

## Install

```
/plugin marketplace add EverMind-AI/EverMe
/plugin install everme-memory@evermind
```

Then run `/mcp`, select `plugin:everme-memory:everme`, and sign in to your EverMe account in the browser. To stop the plugin, disable it with `/plugin`.

You need an EverMe account. Create one at https://everme.evermind.ai.

## What it does

| When | What the plugin does |
|---|---|
| You submit a prompt | Searches your memory for the prompt and adds the hits to the turn as context. Saves the prompt. |
| A tool call ends or fails | Saves the tool name, its input and its result or error. |
| Claude finishes its reply | Saves the final reply and asks EverMe to extract memories from the turn. |

To delete what the plugin saved from the current conversation, ask Claude to forget it. Claude calls `mem_forget_session`, which deletes the original messages saved so far and the memories extracted from them. The plugin keeps saving later turns of the conversation.

To stop saving but keep recall, switch this agent to read-only in EverMe.

Claude can also call the EverMe memory tools itself: `mem_search` and `mem_context`. When you turn them on in EverMe, Claude can call the knowledge-base and connected-app tools too.

Use `/recall <topic>` to search your memory by hand.

## Data this plugin sends

The plugin sends data to one destination: the EverMe API at `https://api.everme.evermind.ai`.

While you have the plugin enabled, it sends this data for each turn of a session:

- the text of your prompt;
- for each tool call, the tool name, the full tool input and the full tool result or error. This includes shell commands and their output, and the contents of files that a tool reads;
- Claude's final reply;
- the Claude Code session id, which groups the turns of one session.

Before EverMe stores this data, it replaces credentials in common formats, such as private keys, access keys and API tokens, with a marker.

The plugin does not save calls to the EverMe tools themselves.

## How EverMe keeps and deletes your data

EverMe stores the data in your account and extracts memories from it: episodes, task cases and skills, and a profile built from your conversations. The profile holds stable facts, traits and preferences. You can see, edit and delete each memory and each profile item at https://everme.evermind.ai.

EverMe keeps the original messages as the source of your memories until you delete them.

- **One conversation:** ask Claude to forget it. This deletes the original messages of the conversation and the memories extracted from them.
- **One memory:** delete it at https://everme.evermind.ai. Search and recall no longer return it.
- **Your account and all of its data:** email support@evermind.ai from the address of your EverMe account. EverMe then deletes the account, its memories and the original messages.

Privacy policy: https://everme.evermind.ai/legal/privacy

## Support

support@evermind.ai
