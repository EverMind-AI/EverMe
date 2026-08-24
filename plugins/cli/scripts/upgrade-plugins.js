// Copyright 2026 Evermind AI
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin refresh invoked from @everme/cli postinstall. After the new binary
 * is on disk, bring already-installed plugin hosts up to the latest plugin
 * line — without any new evercli subcommand. Discovery reuses the read-only
 * `plugin list`; refresh is per host class (see spec
 * .work_context/specs/2026-06-23-cli-postinstall-one-shot-upgrade-design.md).
 */

"use strict";

const fs = require("fs");
const { execFileSync } = require("child_process");

// Quote-delimited bare/latest spec pairs. JSON host configs (cursor,
// claude-desktop, opencode) use double quotes; codex's config.toml uses single
// quotes. Each pair is inherently idempotent — once `@latest` is present the
// bare quoted token no longer exists (the closing quote sits after `@latest`).
const MCP_SPEC_PAIRS = [
  ['"@everme/memory-mcp"', '"@everme/memory-mcp@latest"'],
  ["'@everme/memory-mcp'", "'@everme/memory-mcp@latest'"],
];

const NPX_PLATFORMS = new Set(["cursor", "claude-desktop", "codex", "opencode"]);

const LIST_TIMEOUT_MS = 15000;
const REFRESH_TIMEOUT_MS = 60000;

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function defaultRunner(file, args, opts) {
  return execFileSync(file, args, opts);
}

// discoverHosts runs the read-only `plugin list --format json` against the
// freshly-downloaded binary and returns the platforms array. Throws if the
// envelope is missing or not ok so the caller treats discovery as failed.
function discoverHosts(binPath, runner) {
  const run = runner || defaultRunner;
  const out = run(binPath, ["plugin", "list", "--format", "json"], {
    encoding: "utf8",
    timeout: LIST_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const env = JSON.parse(out);
  if (!env || env.ok !== true || !env.data || !Array.isArray(env.data.platforms)) {
    throw new Error("unexpected `plugin list` envelope shape");
  }
  return env.data.platforms;
}

// patchNpxSpec adds @latest to the memory-mcp spec in a host config file by a
// literal, format-agnostic replace of the quoted bare token. Idempotent: the
// quoted bare token no longer exists once @latest is present. Touches only the
// package spec — never credential fields.
//
// The replace is atomic: write a sibling temp file, fsync, then rename over the
// original. These configs carry credentials, so an interrupted in-place
// truncate/write (crash, disk full) must never leave a corrupted file. The
// original mode is preserved (host configs are 0600).
function patchNpxSpec(configPath) {
  const before = fs.readFileSync(configPath, "utf8");
  let after = before;
  for (const [bare, latest] of MCP_SPEC_PAIRS) {
    if (after.includes(bare)) after = after.split(bare).join(latest);
  }
  if (after === before) return false;
  const mode = fs.statSync(configPath).mode & 0o777;
  const tmp = `${configPath}.everme-tmp-${process.pid}`;
  try {
    const fd = fs.openSync(tmp, "w", mode);
    try {
      fs.writeFileSync(fd, after);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, configPath);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      // temp file may not exist if openSync failed — ignore.
    }
    throw e;
  }
  return true;
}

// refreshClaudeCode brings Claude Code to the latest plugin payload. Two steps
// are required: `evercli plugin install claude-code` reuses an already-present
// global npm package without upgrading it (pluginSourceSpec short-circuits on
// the existing `npm root -g` path), so the @latest bump must happen first; the
// re-install then runs marketplace add-or-update + plugin install-or-update so
// Claude Code actually loads the fresh hooks/commands/MCP, and asserts the
// cached version matches the payload. Step 2 rotates the local agent token
// (per-(platform, fingerprint) — other devices unaffected).
function refreshClaudeCode(binPath, runner) {
  const run = runner || defaultRunner;
  run(npmCommand(), ["install", "-g", "@everme/claude-code@latest"], {
    encoding: "utf8",
    timeout: REFRESH_TIMEOUT_MS,
    stdio: ["ignore", "ignore", "inherit"],
  });
  run(binPath, ["plugin", "install", "claude-code"], {
    encoding: "utf8",
    timeout: REFRESH_TIMEOUT_MS,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

// `plugins update <id>` is the refresh verb: it bumps an already-tracked plugin
// to latest by id (not an npm spec) and leaves openclaw.json alone, unlike
// `install --force`, which reruns the full install-time config scaffolding and
// rewrites the credential-bearing config. The host is already installed in the
// refresh context; if it somehow isn't tracked, update errors and the caller
// degrades it to a warning.
function refreshOpenClaw(runner) {
  const run = runner || defaultRunner;
  run("openclaw", ["plugins", "update", "@everme/openclaw"], {
    encoding: "utf8",
    timeout: REFRESH_TIMEOUT_MS,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

function refreshHermes(binPath, runner) {
  const run = runner || defaultRunner;
  run(binPath, ["plugin", "install", "hermes"], {
    encoding: "utf8",
    timeout: REFRESH_TIMEOUT_MS,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

// Codex needs BOTH refresh paths and used to get only the npx one: its
// memory-mcp spec lives in config.toml (patchNpxSpec), but its hook bundle
// ships through the marketplace cache, which Codex refreshes only when a
// `marketplace upgrade` runs against a changed manifest version. That
// upgrade lives inside `evercli plugin install codex`, so without this the
// hooks stayed pinned to whatever version first installed them.
function refreshCodex(binPath, runner) {
  const run = runner || defaultRunner;
  run(binPath, ["plugin", "install", "codex"], {
    encoding: "utf8",
    timeout: REFRESH_TIMEOUT_MS,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

// Kimi Code mirrors claude-code's npm-first shape: evercli stages the
// bundle from the global npm package and short-circuits on an existing
// directory, so the @latest bump must happen first. Registration is the
// one step evercli cannot do headlessly (`/plugins install` is TUI-only),
// so the staged bundle only reaches Kimi Code after the user re-registers.
function refreshKimicode(binPath, runner) {
  const run = runner || defaultRunner;
  run(npmCommand(), ["install", "-g", "@everme/kimicode@latest"], {
    encoding: "utf8",
    timeout: REFRESH_TIMEOUT_MS,
    stdio: ["ignore", "ignore", "inherit"],
  });
  run(binPath, ["plugin", "install", "kimicode"], {
    encoding: "utf8",
    timeout: REFRESH_TIMEOUT_MS,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

// Raven's Python backend is embedded in the evercli binary, so the freshly
// downloaded binary is the new payload — re-running install is what
// rewrites ~/.raven/plugins/everme-memory/. Nothing to bump on npm.
function refreshRaven(binPath, runner) {
  const run = runner || defaultRunner;
  run(binPath, ["plugin", "install", "raven"], {
    encoding: "utf8",
    timeout: REFRESH_TIMEOUT_MS,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

function skipReason(env) {
  if (env.EVERME_SKIP_PLUGIN_UPGRADE) return "EVERME_SKIP_PLUGIN_UPGRADE is set";
  if (env.CI) return "CI environment";
  if (typeof process.getuid === "function" && process.getuid() === 0) return "running as root";
  if (env.SUDO_USER) return "running under sudo";
  return null;
}

// refreshPlugins is the postinstall entrypoint. It NEVER throws: every failure
// degrades to a stderr warning so `npm i -g` always succeeds.
function refreshPlugins(opts) {
  const { binPath, env, runner } = opts;
  const log = opts.logger || ((m) => console.error(m));

  const skip = skipReason(env);
  if (skip) {
    log(`[@everme/cli] Skipping plugin refresh (${skip}). ` +
      `Re-run \`npm i -g @everme/cli@latest\` as your normal user to refresh plugins.`);
    return;
  }

  let hosts;
  try {
    hosts = discoverHosts(binPath, runner);
  } catch (e) {
    log(`[@everme/cli] Could not enumerate plugin hosts; skipping plugin refresh: ${e.message}`);
    return;
  }

  // The npx patch and the plugin refresh are not alternatives: codex needs
  // both (npx spec in config.toml + marketplace-shipped hook bundle), so
  // the two dispatches run in sequence rather than as one if/else chain.
  for (const h of hosts) {
    if (!h || h.hasEverMeEntry !== true) continue;
    try {
      if (NPX_PLATFORMS.has(h.platform) && h.configPath && patchNpxSpec(h.configPath)) {
        log(`[@everme/cli] ${h.platform}: pinned memory-mcp to @latest`);
      }
      if (h.platform === "claude-code") {
        refreshClaudeCode(binPath, runner);
      } else if (h.platform === "codex") {
        refreshCodex(binPath, runner);
      } else if (h.platform === "openclaw") {
        refreshOpenClaw(runner);
      } else if (h.platform === "hermes") {
        refreshHermes(binPath, runner);
      } else if (h.platform === "raven") {
        refreshRaven(binPath, runner);
      } else if (h.platform === "kimicode") {
        refreshKimicode(binPath, runner);
        log("[@everme/cli] kimicode: bundle staged — run `/plugins install ~/.kimi-code/everme` in the Kimi Code TUI to load it");
      }
    } catch (e) {
      log(`[@everme/cli] ${h.platform}: refresh failed (continuing): ${e.message}`);
    }
  }

  logUnconnectedHosts(hosts, log);
}

// logUnconnectedHosts prints one hint line per agent that is present on this
// machine but has no EverMe entry yet. This replaces the retired
// `evercli plugin scan` reminder flow: discovery already happened via
// `plugin list` above, so an update is the natural moment to surface it.
function logUnconnectedHosts(hosts, log) {
  for (const h of hosts) {
    if (!h || h.installed !== true || h.hasEverMeEntry === true) continue;
    log(`[@everme/cli] Detected ${h.displayName || h.platform} on this machine without EverMe — connect it with: evercli plugin install ${h.platform}`);
  }
}

module.exports = {
  NPX_PLATFORMS,
  LIST_TIMEOUT_MS,
  REFRESH_TIMEOUT_MS,
  npmCommand,
  discoverHosts,
  patchNpxSpec,
  refreshClaudeCode,
  refreshCodex,
  refreshOpenClaw,
  refreshHermes,
  refreshKimicode,
  refreshRaven,
  skipReason,
  refreshPlugins,
  logUnconnectedHosts,
};
