---
name: everme-setup
description: Set up, verify, or repair EverMe memory for Cursor or GitHub Copilot CLI. Use when the user asks to install EverMe, wants this tool to share the work memory they already use in other AI tools, or reports that EverMe is not recalling or not saving here.
---

# EverMe Setup for Cursor and GitHub Copilot CLI

EverMe is work memory for a person and the AI tools they use: one memory of past decisions, solved problems and corrections, kept in the user's EverMe account and shared by every tool they connect.

There are two levels of setup:

- **Sign in only (Cursor).** This plugin adds the `everme-cloud` server. The user signs in to it from Cursor's MCP settings. Then you can search the user's memory and save what the user asks you to keep. Nothing is saved by itself.
- **Full setup (Cursor or Copilot CLI).** The EverMe CLI also adds hooks: they add related memories before each prompt and save each finished turn, including tool calls and results.

If the user is in Cursor and only wants memory they can ask for, Step 0 is enough. Use the full setup for automatic recall and saving, and always for Copilot CLI.

Source: https://github.com/EverMind-AI/EverMe (Apache-2.0). Account and memory management: https://everme.evermind.ai

## Before you start, tell the user

Say these three things and wait for a yes before installing:

1. The EverMe CLI adds hooks and a read-only memory server to this tool's user configuration. Other hooks and servers stay as they are.
2. Each finished turn, with its tool calls and results, is sent to the user's EverMe account at `api.everme.evermind.ai` and saved there. Recall sends the current request as a search query.
3. An EverMe account is required. The user signs in themselves in the browser; you never see or type the password.

Never install or sign in without the user's yes. Never ask for, print or store the agent token. The installer writes it to a file with mode 0600.

## Step 0 (Cursor): sign in to the `everme-cloud` server

1. Ask the user to open Cursor Settings, then **MCP**.
2. Ask the user to find **everme-cloud** and click **Login** (or **Connect**).
3. The browser opens the EverMe sign-in and consent page. The user signs in and allows the connection.
4. Ask the user to start a new chat. The EverMe tools are now listed.

## Requirements for the full setup

- Cursor, or GitHub Copilot CLI
- Node.js, for `npm` and `npx`
- An EverMe account (sign up at https://everme.evermind.ai)

## Step 1: Install the EverMe CLI

```bash
npm install -g @everme/cli
evercli --version
```

## Step 2: Sign in

```bash
evercli auth login
```

This opens the browser. Ask the user to finish the sign-in there, then continue.

## Step 3: Connect this tool

For Cursor:

```bash
evercli plugin install cursor
```

For GitHub Copilot CLI:

```bash
evercli plugin install copilot-cli
```

The command registers this tool as an agent in the user's EverMe account, writes the credentials, the hooks and the `everme-memory` server, and keeps every other entry. Then ask the user to restart Cursor, or to start a new Copilot CLI session.

## Step 4: Verify

Ask the user to:

1. Tell the assistant a work fact, for example "We decided to ship v2 pricing on December 1."
2. Start a new chat or session.
3. Ask "What did we decide about v2 pricing?"

Memories are extracted in the background. If the answer is missing right after step 1, wait a little and ask again before troubleshooting. The user can also see what was saved at https://everme.evermind.ai.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No recall and nothing is saved | Run `evercli plugin install cursor` (or `copilot-cli`) again, then restart the tool. |
| Sign-in expired or the token was revoked | Run `evercli auth login`, then run the install command again. |
| `evercli` is not found | Open a new terminal, or run `npx -y @everme/cli <command>` instead. |
| EverMe tools are listed twice in Cursor | Both the plugin's `everme-cloud` server and the CLI's `everme-memory` server are on. After the full setup, turn off `everme-cloud` in Cursor's MCP settings. |
| Memories appear twice | EverMe is installed twice. Run `evercli plugin uninstall <tool>`, then install once. |

If EverMe cannot be reached, the tool keeps working without memory.

## Uninstall

```bash
evercli plugin uninstall cursor
evercli plugin uninstall copilot-cli
```

Run only the line for the tool the user wants to disconnect. Saved memories stay in the user's EverMe account until the user deletes them at https://everme.evermind.ai.

## Do not

- Do not install, sign in or change the configuration without the user's yes.
- Do not print, copy or move the agent token (`evt_...`). Treat it as a secret.
- Do not confuse EverMe with EverOS. EverOS is a separate memory layer from the same company, with its own plugins and account.
