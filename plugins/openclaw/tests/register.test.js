import { test, describe } from "node:test";
import assert from "node:assert/strict";
import register from "../index.js";

/**
 * Cover the register() entry — specifically the factoryConfig-shape
 * normalisation. Real bug we hit in production: OpenClaw's
 * resolveContextEngine builds factoryConfig as
 *   { config: <ENTIRE openclaw.json>, agentDir, workspaceDir }
 * (see openclaw/dist/registry-*.js). The plugin's actual settings live at
 *   config.plugins.entries["@everme/openclaw"].config
 * — that's also where `evercli plugin install openclaw` writes them.
 *
 * The previous index.js assumed `factoryConfig.config` was already the
 * plugin block. agent-sdk's resolveConfig reads `host.agentId` (flat),
 * saw nothing, env was also empty, assertConfigUsable threw, OpenClaw
 * silently demoted to its legacy engine → EverMe never called.
 *
 * These tests exercise register → factory → engine boot through all
 * shapes we may receive in the wild so the unwrap can't regress.
 */
function fakeApi() {
  const calls = [];
  return {
    logger: { info() {}, warn() {} },
    registered: null,
    registerContextEngine(id, factory) {
      this.registered = { id, factory };
      calls.push({ event: "register", id });
    },
    calls,
  };
}

describe("openclaw register(): factoryConfig shape handling", () => {
  test("real OpenClaw shape: { config: <whole openclaw.json>, agentDir, workspaceDir }", () => {
    const api = fakeApi();
    register(api);
    assert.ok(api.registered, "register must call api.registerContextEngine once");

    // Mirrors what evercli writes and what OpenClaw passes to the factory.
    const engine = api.registered.factory({
      config: {
        agents: { defaults: { workspace: "/tmp/ws" } },
        plugins: {
          allow: ["@everme/openclaw"],
          entries: {
            "@everme/openclaw": {
              enabled: true,
              config: {
                agentId: "agt_real",
                agentToken: "evt_real",
                apiBase: "http://localhost:9",
              },
            },
          },
          slots: { contextEngine: "@everme/openclaw" },
        },
      },
      agentDir: "/tmp/x",
      workspaceDir: "/tmp/y",
    });
    assert.equal(engine.info.id, "@everme/openclaw");
    // If the unwrap is wrong, createContextEngine throws inside
    // resolveConfig with "missing EVERME_AGENT_ID". Reaching here proves
    // we dug into plugins.entries[id].config correctly.
  });

  test("pre-unwrapped shape (hypothetical / future OpenClaw): { config: {agentId, agentToken}, agentDir }", () => {
    const api = fakeApi();
    register(api);
    const engine = api.registered.factory({
      config: {
        agentId: "agt_pre",
        agentToken: "evt_pre",
        apiBase: "http://localhost:9",
      },
      agentDir: "/tmp/x",
    });
    assert.equal(engine.info.id, "@everme/openclaw");
  });

  test("flat shape (back-compat): { agentId, agentToken } at top level", () => {
    const api = fakeApi();
    register(api);
    const engine = api.registered.factory({
      agentId: "agt_flat",
      agentToken: "evt_flat",
      apiBase: "http://localhost:9",
    });
    assert.equal(engine.info.id, "@everme/openclaw");
  });

  test("empty factoryConfig falls back to api.pluginConfig", () => {
    const api = fakeApi();
    api.pluginConfig = {
      agentId: "agt_pluginCfg",
      agentToken: "evt_pluginCfg",
      apiBase: "http://localhost:9",
    };
    register(api);
    const engine = api.registered.factory(undefined);
    assert.equal(engine.info.id, "@everme/openclaw");
  });

  test("OpenClaw shape but plugin entry has no config: assertConfigUsable surfaces clean error (not silent)", () => {
    const api = fakeApi();
    register(api);
    // The plugin is allow-listed but its config block was wiped (e.g.
    // openclaw.json was hand-edited). Must throw so OpenClaw logs the
    // failure, not silently fall back to a stale legacy engine.
    assert.throws(
      () =>
        api.registered.factory({
          config: {
            plugins: {
              entries: { "@everme/openclaw": { enabled: true, config: {} } },
            },
          },
          agentDir: "/x",
        }),
      /missing EVERME_AGENT_ID/,
    );
  });
});
