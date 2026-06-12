# Hermes Provider — manual smoke test

Prereq: a real Hermes install on PATH, an EverMe account, evercli built locally.

1. Build evercli: `cd cli && go build -o /tmp/evercli .`
2. Install: `/tmp/evercli plugin install hermes`
3. Verify on disk:
   - `ls $HOME/.hermes/plugins/everme/` → 5 files present (`__init__.py`, `client.py`, `config.py`, `plugin.yaml`, `README.md`).
   - `stat -f '%Lp' $HOME/.hermes/everme.env` → `600`.
   - `grep -A1 '^memory:' $HOME/.hermes/config.yaml` → `provider: everme`.
   - Under `mcp_servers:` in `$HOME/.hermes/config.yaml` there is no `everme:` entry (migration removed it).
4. Provider loads: start a Hermes CLI session; confirm no plugin load error in
   logs (`~/.hermes/logs/`), and `memory.provider` resolves to everme.
5. Auto-write: hold a short conversation, exit the session (triggers
   on_session_end flush). Confirm a POST to `/mem/agent-memory` in EverMe
   backend logs / the memory appears on the EverMe web UI after worker extraction.
6. Recall: start a new session; confirm the profile block appears in the system
   prompt (check `~/.hermes/logs` debug or `mem_context` tool output).
7. Failure path: set `EVERME_API_BASE=https://127.0.0.1:9` (unreachable),
   confirm the session still runs (no block) and a warning is logged.
