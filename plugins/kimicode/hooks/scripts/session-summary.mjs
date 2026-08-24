#!/usr/bin/env node
/**
 * SessionEnd hook (Kimi Code) — the plugin's sole runtime write. There is no
 * Stop hook: the adapter exposes readSession, so the shared runtime's
 * boundary flush uploads the whole wire.jsonl session in one flushed write
 * (see lib/adapter.js). A session that never reaches SessionEnd (hard crash)
 * is not persisted; recall is unaffected — it reads prior sessions only.
 */

process.on("uncaughtException", () => process.exit(0));
process.on("unhandledRejection", () => process.exit(0));

import { runKimiCodeHook } from "./lib/run-hook.js";

runKimiCodeHook("SessionEnd");
