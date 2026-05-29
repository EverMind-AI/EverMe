import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, isConfigured, _resetCache } from "../hooks/scripts/lib/config.js";

const ORIG_ENV = { ...process.env };

function clearEverme() {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("EVERME_")) delete process.env[k];
  }
  // Point the env-file fallback at a path that doesn't exist so the
  // test machine's real ~/.claude/everme.env doesn't bleed into
  // assertions about "neither token set".
  process.env.EVERME_ENV_FILE_PATH = "/tmp/__nonexistent_everme.env";
  _resetCache();
}

// Write a temporary ~/.claude/everme.env style file and point the loader
// at it. Returns the path so callers can clean it up. Each call uses a
// unique name so tests can run in parallel without stepping on each
// other.
let envFileCounter = 0;
function withEnvFile(contents) {
  envFileCounter += 1;
  const path = join(tmpdir(), `everme-config-test-${process.pid}-${envFileCounter}.env`);
  writeFileSync(path, contents, { mode: 0o600 });
  process.env.EVERME_ENV_FILE_PATH = path;
  _resetCache();
  return path;
}

describe("config", () => {
  beforeEach(() => {
    clearEverme();
  });

  test("isConfigured = false when neither token is set", () => {
    assert.equal(isConfigured(), false);
    const c = getConfig();
    assert.equal(c.authMode, "none");
    assert.equal(c.agentToken, "");
    // SDK normalizes apiBase + appends /api/v1.
    assert.equal(c.baseUrl, "https://api.everme.evermind.ai/api/v1");
  });

  test("evt mode wins when both EVERME_AGENT_TOKEN and EVERME_API_KEY are set", () => {
    process.env.EVERME_AGENT_TOKEN = "evt_a".padEnd(36, "0");
    process.env.EVERME_API_KEY = "emk_b".padEnd(36, "0");
    _resetCache();
    const c = getConfig();
    assert.equal(c.authMode, "evt");
    assert.ok(c.agentToken.startsWith("evt_"));
  });

  test("emk mode when only EVERME_API_KEY is set", () => {
    process.env.EVERME_API_KEY = "emk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    _resetCache();
    const c = getConfig();
    assert.equal(c.authMode, "emk");
    assert.ok(c.agentToken.startsWith("emk_"));
  });

  test("trailing slashes on EVERME_API_BASE are trimmed and /api/v1 appended idempotently", () => {
    process.env.EVERME_API_BASE = "https://api.everme.evermind.ai/";
    process.env.EVERME_API_KEY = "emk_x".padEnd(36, "0");
    _resetCache();
    assert.equal(getConfig().baseUrl, "https://api.everme.evermind.ai/api/v1");

    // Already-suffixed apiBase should not double-append.
    process.env.EVERME_API_BASE = "https://api.everme.evermind.ai/api/v1";
    _resetCache();
    assert.equal(getConfig().baseUrl, "https://api.everme.evermind.ai/api/v1");
  });

  // ─── env-file precedence ─────────────────────────────────────────
  //
  // The two rotated credential keys (EVERME_AGENT_TOKEN, EVERME_AGENT_ID)
  // are evercli's territory; everme.env wins over process.env so a
  // stale .claude.json mcp.env block can't shadow a freshly-rotated
  // evt. Every other EVERME_* key is user-overridable — process.env
  // wins for those.

  describe("env file precedence", () => {
    let createdFiles = [];
    afterEach(() => {
      for (const p of createdFiles) {
        if (existsSync(p)) unlinkSync(p);
      }
      createdFiles = [];
    });

    test("env file overrides process.env for EVERME_AGENT_TOKEN (rotated key)", () => {
      // Simulate a stale token left in process.env by .claude.json mcp.env.
      process.env.EVERME_AGENT_TOKEN = "evt_STALE".padEnd(36, "0");
      const fresh = "evt_FRESH".padEnd(36, "0");
      createdFiles.push(withEnvFile(`EVERME_AGENT_TOKEN=${fresh}\n`));

      const c = getConfig();
      assert.equal(c.authMode, "evt");
      assert.equal(c.agentToken, fresh,
        "freshly-rotated evt in env file must win over a stale process.env value");
    });

    test("env file overrides process.env for EVERME_AGENT_ID (rotated key)", () => {
      process.env.EVERME_AGENT_TOKEN = "evt_x".padEnd(36, "0");
      process.env.EVERME_AGENT_ID = "agt_STALE";
      createdFiles.push(withEnvFile(`EVERME_AGENT_ID=agt_FRESH\n`));

      const c = getConfig();
      assert.equal(c.agentId, "agt_FRESH");
    });

    test("env file does NOT override process.env for EVERME_API_BASE (user-controllable)", () => {
      // User in shell points at a self-hosted EverMe — env file shouldn't clobber.
      process.env.EVERME_API_BASE = "https://evermind.internal.example.com";
      process.env.EVERME_AGENT_TOKEN = "evt_x".padEnd(36, "0");
      createdFiles.push(withEnvFile(
        `EVERME_API_BASE=https://api.everme.evermind.ai\n` +
        `EVERME_AGENT_TOKEN=evt_y${"0".repeat(30)}\n`
      ));

      const c = getConfig();
      assert.equal(c.baseUrl, "https://evermind.internal.example.com/api/v1",
        "user's shell EVERME_API_BASE must beat the env file");
    });

    test("env file does NOT override process.env for EVERME_API_KEY (user emk override)", () => {
      // User exports an emk explicitly to debug a particular account.
      const userEmk = "emk_USERDEBUG".padEnd(36, "0");
      process.env.EVERME_API_KEY = userEmk;
      createdFiles.push(withEnvFile(`EVERME_API_KEY=emk_FROMFILE${"0".repeat(28)}\n`));

      const c = getConfig();
      assert.equal(c.agentToken, userEmk,
        "user-controlled EVERME_API_KEY must beat any value parked in env file");
    });

    test("env file fills gap when process.env is empty for rotated key", () => {
      const fresh = "evt_ONLY_FROM_FILE".padEnd(36, "0");
      createdFiles.push(withEnvFile(`EVERME_AGENT_TOKEN=${fresh}\n`));

      const c = getConfig();
      assert.equal(c.agentToken, fresh);
      assert.equal(c.authMode, "evt");
    });
  });

  test("teardown restores env", () => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("EVERME_")) delete process.env[k];
    }
    for (const [k, v] of Object.entries(ORIG_ENV)) {
      if (k.startsWith("EVERME_")) process.env[k] = v;
    }
    _resetCache();
    assert.ok(true);
  });
});
