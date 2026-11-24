# EverMe for Cursor and GitHub Copilot CLI

In Cursor, this plugin adds the `everme-cloud` memory server. Sign in to it once from Cursor's MCP settings, and the assistant can search your EverMe memory and save what you ask it to keep.

It also adds two skills to Cursor and GitHub Copilot CLI:

- `everme-setup` installs and repairs EverMe with the EverMe CLI. The CLI adds the hooks that recall and save memory, and the read-only `everme-memory` server.
- `everme-memory` tells the assistant when to search EverMe memory and how to use the three read-only tools.

The plugin contains no hooks and no credential. For automatic recall and saving, the EverMe CLI writes hooks to the user configuration of the tool after the user signs in. After that, turn off the plugin's `everme-cloud` server in Cursor, so the memory tools are not listed twice.

## Install

Cursor: install **EverMe** from the Cursor Marketplace.

GitHub Copilot CLI:

```bash
copilot plugin marketplace add EverMind-AI/EverMe
copilot plugin install everme-memory@evermind
```

Then ask the assistant to "set up EverMe". The `everme-setup` skill runs these commands after you agree:

```bash
npm install -g @everme/cli
evercli auth login
evercli plugin install cursor        # or: evercli plugin install copilot-cli
```

You need an EverMe account. Create one at https://everme.evermind.ai.

## Data

Each finished turn, with its tool calls and results, is saved to your EverMe account at `api.everme.evermind.ai`. Recall sends the current request as a search query. Review, edit or delete your memory at https://everme.evermind.ai.

- Privacy policy: https://everme.evermind.ai/legal/privacy
- Terms of service: https://everme.evermind.ai/legal/terms
- Support: https://evermind.ai/contact-us

## License

Apache-2.0
