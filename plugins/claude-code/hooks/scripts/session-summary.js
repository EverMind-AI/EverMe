#!/usr/bin/env node

process.on("uncaughtException", () => process.exit(0));
process.on("unhandledRejection", () => process.exit(0));

import { runClaudeCodeHook } from "./lib/run-hook.js";

runClaudeCodeHook("SessionEnd");
