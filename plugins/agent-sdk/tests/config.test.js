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
});
