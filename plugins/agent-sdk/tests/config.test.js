import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, assertConfigUsable } from "../src/config.js";

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
    assert.equal(c.injectTopK, 10);
    assert.equal(c.injectProfile, false);
    assert.equal(c.injectMinScore, 0.1);
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
    assert.equal(invalid.injectTopK, 10);
    assert.equal(invalid.injectMinScore, 0.1);
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
});
