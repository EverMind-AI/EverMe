# EverMe memory for Codex and ChatGPT

This is the EverMe plugin for the OpenAI plugin directory. It has skills and one remote MCP server, and no lifecycle hooks, because the directory does not accept plugins with hooks.

## What it does

- Searches your EverMe memory when you refer to earlier conversations, decisions or solved problems.
- Reads your profile.
- Saves a fact or part of a conversation when you ask.
- Forgets what the current conversation saved when you ask.

It does not save your conversations by itself.

EverMe is work memory for you and the AI tools you use. It is built on EverOS, EverMind's context and memory layer for AI agents. EverOS has its own plugin, for teams that connect their own agents to it. It uses a separate account.

## Sign in

The plugin connects to `https://api.everme.evermind.ai/mcp` and signs you in to your EverMe account with OAuth. It stores no credential. You need an EverMe account. Create one at https://everme.evermind.ai.

The MCP server is named `everme-memory`, so it does not replace an `everme` server that `evercli` added to your Codex configuration. The MCP configuration declares OAuth with Dynamic Client Registration (DCR) under `extensions["com.openai"].auth`. The client finds the registration, authorization and token endpoints in the OAuth metadata of the server. It requests `mem:read`, `mem:search`, and `mem:write` for memory access, and `openid` and `email` for account identity. The authorization server requires PKCE with `S256`. Do not add access tokens or client secrets to the plugin.

## Build the submission ZIP

From the repository's `plugins/` directory, run:

```sh
npm run build:codex-directory -- --output /absolute/path/to/local-delivery
```

The command validates the OAuth configuration and component paths. It creates `everme-openai-0.1.1.zip` and a matching `.sha256` file. The ZIP contains only the manifest, MCP configuration, README, icon, and memory skill, with no parent directory. The current manifest layout remains supported for submission.

Use an empty output directory. Before submission, install the ZIP contents in a clean client and verify browser OAuth, memory search, and a user-requested save. A successful build does not prove login or tool access.

## Data this plugin sends

The plugin sends data to one destination: the EverMe API at `https://api.everme.evermind.ai`.

- A search sends the search query.
- A save sends only the fact or the messages you asked to save.

Before EverMe stores a save, it replaces credentials in common formats, such as private keys, access keys and API tokens, with a marker.

## How EverMe keeps and deletes your data

EverMe stores saved content in your account and extracts memories from it: episodes and a profile built from what you saved. The profile holds stable facts, traits and preferences. You can see, edit and delete each memory and each profile item at https://everme.evermind.ai.

EverMe keeps the saved messages as the source of your memories until you delete them.

- **One memory:** delete it at https://everme.evermind.ai. Search and recall no longer return it.
- **Your account and all of its data:** email support@evermind.ai from the address of your EverMe account. EverMe then deletes the account, its memories and the saved messages.

Privacy policy: https://everme.evermind.ai/legal/privacy

## Support

support@evermind.ai
