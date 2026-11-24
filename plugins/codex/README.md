# @everme/codex

Native EverMe lifecycle hook source for Codex. The release build bundles this
package and `@everme/agent-sdk` into `plugins/everme/bin/hook.mjs`, which is
shipped inside the EverMe Codex marketplace plugin and uses the stable
`/api/v1/mem/*` BFF contract.

## Lifecycle

- `SessionStart`: inject the EverMe profile snapshot.
- `UserPromptSubmit`: sanitize the prompt, search top 10 memories, and inject
  recall without passive profile rows by default.
- `Stop`: stream the Codex rollout, save the latest real user turn and its
  visible assistant/tool trajectory; when no real user exists, retain genuine
  assistant/tool activity instead of requiring a synthetic user boundary.
  The hook also discovers completed descendant rollouts in the same session
  directory and skips children without a real user after filtering, without
  advancing their checkpoints. Flush extraction every five root turns.
  Developer prompts, injected context, UI notifications, reasoning, and
  subagent user/task context are excluded. Goal continuations retain only the
  explicitly user-provided objective, not scheduler instructions or budgets.
- `PreCompact`: send a flush-only request.

Native paginated rollouts isolate transcript checkpoints by the filename's
thread UUID (`codex-fragment-<uuid>`), even when multiple files share the hook
session ID. The same scope accompanies every write and matches cold-start
fragment coordinates; logical conversation attribution stays unchanged.
Unscoped legacy checkpoints are not copied into fragment state. A newly seen
root fragment still captures only its last turn, then captures appended messages
on later Stops; this is not automatic historical replay. Before writing, the SDK
requires `hookSyncScopeSupported` from the server's memory-state endpoint.
Deploy the server before the plugin; unsupported servers leave the checkpoint
unchanged. Separate session flush requests retain their existing contract.

Both realtime capture and Codex cold-start import first plan user tasks. Fitting
tasks keep their tool results unchanged. Tasks exceeding the 280 KiB message
budget try 4, 3, then 2 KiB UTF-8 tool-result budgets from original content,
retaining 70% head and 30% tail around a byte-count marker. Compression changes
no IDs, arguments, timestamps or ordering. Count-only overflow is not compressed.
The 64 KiB soft target cannot split a fitting task; remaining byte or 500-message
overflow prefers text edges, then complete tool pairs, then hard cuts. Hard
fallbacks cannot guarantee a user or text edges in every batch. Existing
redaction and ordinary-text budgets remain unchanged, as do checkpoint and
flush semantics. The shared SDK strategy is opt-in, currently enabled by Codex.

Both paths retain recorded empty tool results as empty content with their
original call id. Legacy wrappers without native IDs are dropped with bounded
count diagnostics; neither line-number IDs nor inferred pairing are used.
A standalone `web_search_call` has no paired result:
its source payload is retained as JSON text in an assistant message, subject to
the normal redaction and length limits. It does not create a synthetic tool call
or result, and an absent source status is not replaced with a success claim.

Tool arguments are JSON-encoded strings: existing JSON is retained, empty
arguments become `{}`, and unstructured legacy/function input is preserved as
`{"input":"original text"}`. Local `turnId` and tri-state `turnComplete`
metadata guide SDK batching without adding fields to the BFF message contract.
Native function/custom calls and results must carry a non-blank string
`call_id`. Invalid records are dropped with bounded count diagnostics; no
fallback ID is generated and no missing ID is inferred from pending calls.
Valid source IDs are preserved unchanged.
Explicit final answers and completion events identify completed turns;
commentary and standalone search records do not close a turn. Unknown or
malformed records and filtering reasons produce one bounded count summary per
transcript, without source text or credentials.

All hook failures are fail-open and credentials are redacted from diagnostics.
`evercli plugin install codex` writes credentials to `~/.codex/everme.env`
with mode `0600`; the user reviews and trusts the commands in `/hooks`. Hook
execution does not install or download an npm package at runtime.

## Marketplace build

```bash
npm run build:marketplace
```

The generated `../everme/bin/hook.mjs` is committed with the marketplace
plugin. `npm test --workspace @everme/codex` rebuilds it before running the
isolated runner test.

## Where memory is kept

Without EverMe Desktop, this plugin saves memory in the EverMe cloud. To keep memory only on this Mac, install EverMe Desktop and turn on local memory. The plugin then sends memory to the local memory gateway that EverMe Desktop runs (it reads `~/.everme/memory/route.json` on each request).

Each EverMe account keeps its memory in one place: the cloud, or one Mac. If your account keeps its memory on another Mac, the cloud refuses memory from this computer, and the error names that Mac. To save memory from here, switch the account back to the cloud on that Mac, or on the web if that Mac is gone.

## Configuration

The shared hook knobs are `EVERME_INJECT_TOPK`, `EVERME_INJECT_PROFILE`,
`EVERME_INJECT_MIN_SCORE`, `EVERME_FLUSH_EVERY_TURNS`,
`EVERME_FLUSH_MODE`, and `EVERME_STATE_DIR`.

## License

Apache-2.0.
