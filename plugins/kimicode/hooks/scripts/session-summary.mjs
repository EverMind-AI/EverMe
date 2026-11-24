#!/usr/bin/env node
/**
 * SessionEnd hook (Kimi Code) — uploads the root wire.jsonl session and catches
 * up any child transcript not already checkpointed by SubagentStop. Each agent
 * keeps a separate conversation id and successful uploads advance its own
 * checkpoint.
 */

process.on("uncaughtException", () => process.exit(0));
process.on("unhandledRejection", () => process.exit(0));

import { runKimiCodeHook } from "./lib/run-hook.js";

runKimiCodeHook("SessionEnd");
