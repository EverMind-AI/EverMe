#!/usr/bin/env node
// Copyright 2026 Evermind AI
// SPDX-License-Identifier: Apache-2.0

/**
 * `everme` bin entry. Three responsibilities:
 *
 *   1. On Windows, recover from a crashed self-update that left the binary
 *      renamed to `.old` (evercli is expected to atomically rename
 *      <bin> → <bin>.old, write new <bin>, and clear <bin>.old on success;
 *      if the process dies between rename and write, we restore here).
 *
 *   2. Route the `install` subcommand to install-wizard.js without exec'ing
 *      the binary. The wizard provisions tokens and writes plugin entries
 *      into Claude Code / Cursor / OpenClaw config files; it doesn't need
 *      the Go binary itself.
 *
 *   3. For every other subcommand, ensure the binary is on disk (lazy
 *      download via install.js if missing — covers the npx postinstall-skip
 *      path), then exec it with the user's args.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const NAME = "evercli";
const ext = process.platform === "win32" ? ".exe" : "";
const bin = path.join(__dirname, "..", "bin", NAME + ext);
const oldBin = bin + ".old";

function restoreOldBinary() {
  try {
    if (fs.existsSync(bin)) fs.rmSync(bin, { force: true });
    fs.renameSync(oldBin, bin);
    return true;
  } catch (_) {
    return false;
  }
}

if (process.platform === "win32" && fs.existsSync(oldBin)) {
  if (!fs.existsSync(bin)) {
    restoreOldBinary();
  } else {
    // Both bin and bin.old exist — verify the new one works; if it does,
    // drop bin.old; otherwise restore it.
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore", timeout: 10000 });
      try {
        fs.rmSync(oldBin, { force: true });
      } catch (_) {
        // Best-effort cleanup; the healthy binary still runs.
      }
    } catch (_) {
      restoreOldBinary();
    }
  }
}

const args = process.argv.slice(2);

if (args[0] === "install") {
  // The wizard runs even if the binary is missing — that's the whole point
  // of having it on the JS side.
  require("./install-wizard.js");
} else {
  if (!fs.existsSync(bin)) {
    try {
      execFileSync(process.execPath, [path.join(__dirname, "install.js")], {
        stdio: "inherit",
        env: { ...process.env, EVERME_CLI_RUN: "true" },
      });
    } catch (_) {
      console.error(
        `\nFailed to auto-install ${NAME} binary.\n` +
          `To fix, run the install script manually:\n` +
          `  node "${path.join(__dirname, "install.js")}"\n`,
      );
      process.exit(1);
    }
  }
  try {
    execFileSync(bin, args, { stdio: "inherit" });
  } catch (e) {
    // Preserve the child's exit semantics. execFileSync throws an Error
    // whose `.status` is the exit code OR null when the child was killed
    // by a signal (`.signal` is set instead). Mapping signal → 128+N
    // matches POSIX shell convention so callers (CI, parent shells) can
    // distinguish SIGINT (130) from a clean exit 1.
    if (typeof e.status === "number") {
      process.exit(e.status);
    }
    if (e.signal && os.constants.signals && os.constants.signals[e.signal]) {
      process.exit(128 + os.constants.signals[e.signal]);
    }
    process.exit(1);
  }
}
