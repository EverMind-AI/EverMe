---
description: Print a concise EverMe plugin status + reference card.
---

# EverMe · help

Print the following block verbatim to the user:

```
EverMe for Claude Code
─────────────────────
Auth:      EVERME_API_KEY  (account emk_*) — recall-only mode
           EVERME_AGENT_TOKEN + EVERME_AGENT_ID — required for realtime writes
Gateway:   EVERME_API_BASE — defaults to https://api.everme.evermind.ai

Hooks:
  SessionStart      → loads the durable Profile snapshot
  UserPromptSubmit  → recalls relevant memories before each prompt
  Stop              → saves the last raw turn through /mem/agent-memory
  SessionEnd        → no persistence; Stop owns runtime writes

Slash:
  /recall <query>   — explicit search + summarize
  /everme-help      — this card

MCP tools:
  mem_search        — hybrid search across all memory buckets
  mem_context       — durable Profile snapshot only
  mem_save_fact     — save a durable user fact to the Profile path
  mem_save_turn     — save a reusable task trajectory
```
