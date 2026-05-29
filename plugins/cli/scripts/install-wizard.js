#!/usr/bin/env node
// Copyright 2026 Evermind AI
// SPDX-License-Identifier: Apache-2.0

/**
 * `evercli install` wizard. Runs without the binary present, which lets
 * `npx @everme/cli install` work even when the postinstall step was skipped
 * (npx, restricted CI). Responsibilities:
 *
 *   1. Print a short banner so users know what's happening.
 *   2. Ensure the platform-native binary is downloaded (calls install.js
 *      with EVERME_CLI_RUN=true to bypass the npx-skip guard).
 *   3. Exec the binary's own `install` subcommand, which is where the real
 *      provisioning lives (login, agent token, plugin registration into
 *      Claude Code / Cursor / OpenClaw config files).
 *
 * Anything beyond step 3 belongs in the Go binary, not here. Keeping this
 * thin means we don't have to ship feature parity in JS.
 */

const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

const NAME = "evercli";
const ext = process.platform === "win32" ? ".exe" : "";
const bin = path.join(__dirname, "..", "bin", NAME + ext);

const VERSION = require("../package.json").version;

console.log(`\n  EverMe CLI installer (v${VERSION})`);
console.log(`  ────────────────────────────────────`);
console.log(`  Persistent memory for AI agents.\n`);

if (!fs.existsSync(bin)) {
  console.log(`  → downloading evercli binary for ${process.platform}-${process.arch}`);
  try {
    execFileSync(process.execPath, [path.join(__dirname, "install.js")], {
      stdio: "inherit",
      env: { ...process.env, EVERME_CLI_RUN: "true" },
    });
  } catch (_) {
    console.error(
      `\n  Could not download the evercli binary. See errors above for details.\n` +
        `  Once resolved, re-run: npx @everme/cli install\n`,
    );
    process.exit(1);
  }
}

// Hand off to the Go binary's own install/setup flow. If the binary doesn't
// implement an `install` subcommand yet, surfacing the help text is still a
// reasonable "first-run" experience.
try {
  execFileSync(bin, ["install"], { stdio: "inherit" });
} catch (e) {
  // Exit with the binary's status if it ran but failed; fall back to 1
  // (binary missing, EACCES, etc.).
  process.exit(e.status || 1);
}
