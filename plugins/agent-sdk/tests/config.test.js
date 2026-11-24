import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig, assertConfigUsable } from "../src/config.js";
import { DEFAULT_INJECT_MIN_SCORE } from "../src/hooks/knobs.js";

describe("config", () => {
  test("env vars feed defaults", () => {
    process.env.EVERME_API_BASE = "https://example.test";
    process.env.EVERME_AGENT_ID = "agt_x";
    process.env.EVERME_AGENT_TOKEN = "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const c = resolveConfig({});
    assert.equal(c.baseUrl, "https://example.test/api/v1");
    assert.equal(c.agentId, "agt_x");
    assert.equal(c.agentToken, "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  test("/api/v1 is appended exactly once", () => {
    process.env.EVERME_API_BASE = "https://example.test/api/v1";
    const c = resolveConfig({});
    assert.equal(c.baseUrl, "https://example.test/api/v1");
  });

  test("trailing slash is trimmed before adding prefix", () => {
    process.env.EVERME_API_BASE = "https://example.test///";
    const c = resolveConfig({});
    assert.equal(c.baseUrl, "https://example.test/api/v1");
  });

  test("host config overrides env", () => {
    process.env.EVERME_AGENT_ID = "agt_env";
    const c = resolveConfig({ agentId: "agt_host" });
    assert.equal(c.agentId, "agt_host");
  });

  test("explicit empty credentials override conflicting environment values", () => {
    process.env.EVERME_AGENT_ID = "agt_env";
    process.env.EVERME_AGENT_TOKEN = "evt_" + "e".repeat(32);

    const explicit = resolveConfig({ agentId: "", agentToken: "" });
    assert.equal(explicit.agentId, "");
    assert.equal(explicit.agentToken, "");

    const omitted = resolveConfig({});
    assert.equal(omitted.agentId, "agt_env");
    assert.equal(omitted.agentToken, "evt_" + "e".repeat(32));
  });

  test("hook settings use the P0 defaults", () => {
    delete process.env.EVERME_FLUSH_EVERY_TURNS;
    delete process.env.EVERME_FLUSH_MODE;
    delete process.env.EVERME_INJECT_TOPK;
    delete process.env.EVERME_INJECT_PROFILE;
    delete process.env.EVERME_INJECT_MIN_SCORE;

    const c = resolveConfig({});

    assert.equal(c.flushEveryTurns, 5);
    assert.equal(c.flushMode, "");
    assert.equal(c.injectTopK, 5);
    assert.equal(c.injectProfile, false);
    assert.equal(c.injectMinScore, 0.3);
  });

  test("legacy flush mode restores every-turn flushing", () => {
    process.env.EVERME_FLUSH_EVERY_TURNS = "9";
    process.env.EVERME_FLUSH_MODE = "legacy";

    const c = resolveConfig({});

    assert.equal(c.flushEveryTurns, 1);
    assert.equal(c.flushMode, "legacy");
  });

  test("hook numeric settings parse strictly and clamp to supported ranges", () => {
    process.env.EVERME_FLUSH_MODE = "";
    process.env.EVERME_FLUSH_EVERY_TURNS = "0";
    process.env.EVERME_INJECT_TOPK = "99";
    process.env.EVERME_INJECT_PROFILE = "1";
    process.env.EVERME_INJECT_MIN_SCORE = "2";

    const high = resolveConfig({});
    assert.equal(high.flushEveryTurns, 0);
    assert.equal(high.injectTopK, 20);
    assert.equal(high.injectProfile, true);
    assert.equal(high.injectMinScore, 1);

    process.env.EVERME_INJECT_TOPK = "1x";
    process.env.EVERME_INJECT_MIN_SCORE = "not-a-number";

    const invalid = resolveConfig({});
    assert.equal(invalid.injectTopK, 5);
    assert.equal(invalid.injectMinScore, 0.3);
  });

  test("assertConfigUsable rejects missing token", () => {
    process.env.EVERME_AGENT_ID = "agt_x";
    delete process.env.EVERME_AGENT_TOKEN;
    const c = resolveConfig({});
    // The error must mention what's missing but never echo the token.
    assert.throws(
      () => assertConfigUsable(c),
      /EVERME_AGENT_TOKEN/,
    );
  });

  test("assertConfigUsable names the brand of the credentials", () => {
    assert.throws(
      () => assertConfigUsable({ agentId: "agt_x", agentToken: "", brand: "everos" }),
      (err) => /^EverOS plugin: missing EVERME_AGENT_TOKEN/.test(err.message),
    );
    assert.throws(
      () => assertConfigUsable({ agentId: "agt_x", agentToken: "", brand: "everme" }),
      (err) => /^EverMe plugin: missing EVERME_AGENT_TOKEN/.test(err.message),
    );
  });

  test("assertConfigUsable can omit agent id for request-authenticated HTTP", () => {
    const agentToken = "evt_" + "a".repeat(32);
    assert.doesNotThrow(() =>
      assertConfigUsable(
        { agentId: "", agentToken },
        { requireAgentId: false },
      ),
    );
  });

  test("assertConfigUsable always requires the agent token", () => {
    assert.throws(
      () => assertConfigUsable({ agentId: "", agentToken: "" }, { requireAgentId: false }),
      /EVERME_AGENT_TOKEN/,
    );
  });

  test("resolveConfig passes clientKind and clientVersion through untouched", () => {
    const cfg = resolveConfig({ agentId: "a", agentToken: "t", clientKind: "mcp", clientVersion: "0.6.4" });
    assert.equal(cfg.clientKind, "mcp");
    assert.equal(cfg.clientVersion, "0.6.4");
    assert.equal(resolveConfig({ agentId: "a", agentToken: "t" }).clientKind, undefined);
  });

  test("the route's recall floor is the default; EVERME_INJECT_MIN_SCORE still wins", () => {
    const home = mkdtempSync(join(tmpdir(), "everme-floor-"));
    const saved = process.env.EVERME_INJECT_MIN_SCORE;
    try {
      delete process.env.EVERME_INJECT_MIN_SCORE;
      assert.equal(resolveConfig({ memoryHome: home }).injectMinScore, DEFAULT_INJECT_MIN_SCORE);
      writeFileSync(join(home, "route.json"), JSON.stringify({ mode: "local", apiBase: "http://127.0.0.1:47391", injectMinScore: 0.1 }));
      assert.equal(resolveConfig({ memoryHome: home }).injectMinScore, 0.1);
      process.env.EVERME_INJECT_MIN_SCORE = "0.25";
      assert.equal(resolveConfig({ memoryHome: home }).injectMinScore, 0.25);
      assert.equal(resolveConfig({ memoryHome: home, injectMinScore: 0.4 }).injectMinScore, 0.4);
    } finally {
      if (saved === undefined) delete process.env.EVERME_INJECT_MIN_SCORE;
      else process.env.EVERME_INJECT_MIN_SCORE = saved;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
