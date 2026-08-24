# Raven backend — manual smoke test

Prereq: a real Raven install (`raven doctor` passes), Raven >= the
version that adds user-dir plugins to `sys.path` before factory import,
an EverMe account, evercli built locally.

1. Build evercli: `cd cli && go build -o /tmp/evercli .`
2. Install: `/tmp/evercli plugin install raven`
3. Verify on disk:
   - `ls ~/.raven/plugins/everme-memory/` → `raven-plugin.toml` +
     `everme_raven/` (4 files) + `README.md`.
   - `python3 -c "import json;c=json.load(open('$HOME/.raven/config.json'));print(c['memory']['backend'], bool(c['plugins']['config']['everme-memory']['agent_token']))"`
     → `everme True`.
   - A `~/.raven/config.json.bak` backup exists when the config predated install.
4. Plugin loads: `raven plugins` lists `everme-memory` (source: user) and
   the `everme` backend as selected; no factory import error in logs.
5. Auto-write: run `raven agent -m "remember that I like durian"`, then
   confirm a POST to `/mem/agent-memory` in EverMe backend logs / the
   memory appears on the EverMe web UI after worker extraction.
6. Recall: start a new session and ask about the fact; the `# Memory`
   prompt segment should carry the profile block + recall bullets.
7. Failure path: set `api_base` to an unreachable host in
   `plugins.config["everme-memory"]`; the session must still run
   (recall returns empty, store logs a warning — no turn abort).
8. Exclusivity note: while `memory.backend = "everme"`, the bundled
   `everos` backend is inactive. Restore the previous value from the
   `.bak` to switch back.
