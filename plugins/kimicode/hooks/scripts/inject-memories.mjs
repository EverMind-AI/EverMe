#!/usr/bin/env node

process.on("uncaughtException", () => process.exit(0));
process.on("unhandledRejection", () => process.exit(0));

import { runKimiCodeHook } from "./lib/run-hook.js";

runKimiCodeHook("UserPromptSubmit");
