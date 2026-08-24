"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const mod = require("../scripts/upgrade-plugins.js");

function tmpFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everme-up-"));
  const p = path.join(dir, "config.json");
  fs.writeFileSync(p, contents);
  return p;
}

test("patchNpxSpec rewrites a bare spec and is idempotent", () => {
  const p = tmpFile('{"args":["-y","@everme/memory-mcp"]}');
  assert.equal(mod.patchNpxSpec(p), true);
  assert.match(fs.readFileSync(p, "utf8"), /@everme\/memory-mcp@latest/);
  // second run: nothing to change
  assert.equal(mod.patchNpxSpec(p), false);
  // exactly one @latest, no double-suffix
  const after = fs.readFileSync(p, "utf8");
  assert.equal((after.match(/@latest/g) || []).length, 1);
});

test("patchNpxSpec leaves a config without the bare spec untouched", () => {
  const p = tmpFile('{"args":["-y","@everme/memory-mcp@latest"]}');
  assert.equal(mod.patchNpxSpec(p), false);
});

test("patchNpxSpec rewrites a TOML single-quoted spec and is idempotent", () => {
  // codex's config.toml uses single quotes: args = ['-y', '@everme/memory-mcp']
  const p = tmpFile("args = ['-y', '@everme/memory-mcp']\n");
  assert.equal(mod.patchNpxSpec(p), true);
  assert.match(fs.readFileSync(p, "utf8"), /'@everme\/memory-mcp@latest'/);
  // second run: nothing to change
  assert.equal(mod.patchNpxSpec(p), false);
  // exactly one @latest, no double-suffix
  const after = fs.readFileSync(p, "utf8");
  assert.equal((after.match(/@latest/g) || []).length, 1);
});

test("patchNpxSpec preserves the file mode and leaves no temp file", () => {
  const p = tmpFile('{"args":["-y","@everme/memory-mcp"]}');
  fs.chmodSync(p, 0o600);
  assert.equal(mod.patchNpxSpec(p), true);
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  // atomic rename leaves no sibling temp artifact behind
  const siblings = fs.readdirSync(path.dirname(p));
  assert.deepEqual(siblings, ["config.json"]);
});

test("discoverHosts parses the plugin list envelope", () => {
  const fakeRunner = (file, args) => {
    assert.deepEqual(args, ["plugin", "list", "--format", "json"]);
    return JSON.stringify({
      ok: true,
      data: { platforms: [{ platform: "codex", configPath: "/c", hasEverMeEntry: true }] },
    });
  };
  const hosts = mod.discoverHosts("/bin/evercli", fakeRunner);
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].platform, "codex");
});

test("discoverHosts throws on a non-ok envelope", () => {
  const fakeRunner = () => JSON.stringify({ ok: false, error: { message: "boom" } });
  assert.throws(() => mod.discoverHosts("/bin/evercli", fakeRunner));
});

test("refreshClaudeCode upgrades the npm package then re-registers the plugin", () => {
  const calls = [];
  const runner = (file, args) => { calls.push([file, args]); return ""; };
  mod.refreshClaudeCode("/bin/evercli", runner);
  assert.equal(calls.length, 2);
  // 1. force-upgrade the global npm package
  assert.match(calls[0][0], /^npm(\.cmd)?$/);
  assert.deepEqual(calls[0][1], ["install", "-g", "@everme/claude-code@latest"]);
  // 2. re-register so Claude Code loads the fresh payload
  assert.equal(calls[1][0], "/bin/evercli");
  assert.deepEqual(calls[1][1], ["plugin", "install", "claude-code"]);
});

test("refreshOpenClaw updates the tracked plugin by id", () => {
  // `plugins update <id>` is the refresh verb: it bumps an already-tracked
  // plugin to latest without the full config-overwrite that `install` runs.
  const calls = [];
  const runner = (file, args) => { calls.push([file, args]); return ""; };
  mod.refreshOpenClaw(runner);
  assert.equal(calls[0][0], "openclaw");
  assert.deepEqual(calls[0][1], ["plugins", "update", "@everme/openclaw"]);
});

test("refreshHermes runs <binPath> plugin install hermes", () => {
  const calls = [];
  const runner = (file, args) => { calls.push([file, args]); return ""; };
  mod.refreshHermes("/bin/evercli", runner);
  assert.equal(calls[0][0], "/bin/evercli");
  assert.deepEqual(calls[0][1], ["plugin", "install", "hermes"]);
});

test("refreshCodex re-registers so the marketplace hook bundle is upgraded", () => {
  // The npx patch alone never refreshes codex's marketplace cache; the
  // `marketplace upgrade` lives inside `plugin install codex`.
  const calls = [];
  const runner = (file, args) => { calls.push([file, args]); return ""; };
  mod.refreshCodex("/bin/evercli", runner);
  assert.equal(calls[0][0], "/bin/evercli");
  assert.deepEqual(calls[0][1], ["plugin", "install", "codex"]);
});

test("refreshKimicode upgrades the npm bundle then re-stages it", () => {
  const calls = [];
  const runner = (file, args) => { calls.push([file, args]); return ""; };
  mod.refreshKimicode("/bin/evercli", runner);
  assert.equal(calls.length, 2);
  assert.match(calls[0][0], /^npm(\.cmd)?$/);
  assert.deepEqual(calls[0][1], ["install", "-g", "@everme/kimicode@latest"]);
  assert.equal(calls[1][0], "/bin/evercli");
  assert.deepEqual(calls[1][1], ["plugin", "install", "kimicode"]);
});

test("refreshRaven re-installs the embedded backend without touching npm", () => {
  const calls = [];
  const runner = (file, args) => { calls.push([file, args]); return ""; };
  mod.refreshRaven("/bin/evercli", runner);
  assert.equal(calls.length, 1, "the payload ships inside the binary — nothing to npm-install");
  assert.equal(calls[0][0], "/bin/evercli");
  assert.deepEqual(calls[0][1], ["plugin", "install", "raven"]);
});

test("skipReason fires for CI, sudo, root, and opt-out", () => {
  assert.ok(mod.skipReason({ CI: "true" }));
  assert.ok(mod.skipReason({ SUDO_USER: "bob" }));
  assert.ok(mod.skipReason({ EVERME_SKIP_PLUGIN_UPGRADE: "1" }));
  assert.equal(mod.skipReason({}), null);
});

test("refreshPlugins dispatches per host class and skips entries without everme", () => {
  const platforms = [
    { platform: "codex", configPath: tmpFile('{"args":["-y","@everme/memory-mcp"]}'), hasEverMeEntry: true },
    { platform: "cursor", configPath: "/nope", hasEverMeEntry: false }, // skipped: no entry
    { platform: "claude-code", hasEverMeEntry: true },
    { platform: "openclaw", hasEverMeEntry: true },
    { platform: "hermes", hasEverMeEntry: true },
    { platform: "raven", hasEverMeEntry: true },
    { platform: "kimicode", hasEverMeEntry: true },
  ];
  const seen = [];
  const runner = (file, args) => {
    if (args[0] === "plugin" && args[1] === "list") {
      return JSON.stringify({ ok: true, data: { platforms } });
    }
    seen.push(`${file} ${args.join(" ")}`);
    return "";
  };
  mod.refreshPlugins({ binPath: "/bin/evercli", env: {}, runner, logger: () => {} });

  // codex npx config got @latest
  assert.match(fs.readFileSync(platforms[0].configPath, "utf8"), /@everme\/memory-mcp@latest/);
  // codex ALSO gets a plugin refresh: the npx patch leaves its
  // marketplace-shipped hook bundle stale on its own.
  assert.ok(seen.some((c) => /\/bin\/evercli plugin install codex/.test(c)));
  // claude-code / kimicode: npm upgrade + binary re-register
  assert.ok(seen.some((c) => /@everme\/claude-code@latest/.test(c)));
  assert.ok(seen.some((c) => /\/bin\/evercli plugin install claude-code/.test(c)));
  assert.ok(seen.some((c) => /@everme\/kimicode@latest/.test(c)));
  assert.ok(seen.some((c) => /\/bin\/evercli plugin install kimicode/.test(c)));
  // openclaw / hermes / raven once each
  assert.ok(seen.some((c) => /openclaw plugins update @everme\/openclaw/.test(c)));
  assert.ok(seen.some((c) => /\/bin\/evercli plugin install hermes/.test(c)));
  assert.ok(seen.some((c) => /\/bin\/evercli plugin install raven/.test(c)));
});

test("refreshPlugins never throws when an action fails", () => {
  const platforms = [{ platform: "openclaw", hasEverMeEntry: true }];
  const runner = (file, args) => {
    if (args[1] === "list") return JSON.stringify({ ok: true, data: { platforms } });
    throw new Error("openclaw not on PATH");
  };
  const warnings = [];
  assert.doesNotThrow(() =>
    mod.refreshPlugins({ binPath: "/bin/evercli", env: {}, runner, logger: (m) => warnings.push(m) }),
  );
  assert.ok(warnings.some((m) => /openclaw/.test(m)));
});

test("refreshPlugins is a no-op under a guard", () => {
  let called = false;
  const runner = () => { called = true; return ""; };
  mod.refreshPlugins({ binPath: "/bin/evercli", env: { CI: "1" }, runner, logger: () => {} });
  assert.equal(called, false);
});

test("refreshPlugins hints at detected hosts without an EverMe entry", () => {
  const platforms = [
    { platform: "cursor", displayName: "Cursor", installed: true, hasEverMeEntry: false },
    { platform: "devin", displayName: "Devin", installed: false, hasEverMeEntry: false },
    { platform: "hermes", displayName: "Hermes", installed: true, hasEverMeEntry: true },
  ];
  const runner = (file, args) => {
    if (args[0] === "plugin" && args[1] === "list") {
      return JSON.stringify({ ok: true, data: { platforms } });
    }
    return "";
  };
  const lines = [];
  mod.refreshPlugins({ binPath: "/bin/evercli", env: {}, runner, logger: (m) => lines.push(m) });

  const hints = lines.filter((m) => /without EverMe/.test(m));
  assert.equal(hints.length, 1, "only the installed-but-unconnected host gets a hint");
  assert.match(hints[0], /Cursor/);
  assert.match(hints[0], /evercli plugin install cursor/);
});
