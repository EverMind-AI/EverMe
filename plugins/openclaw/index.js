/**
 * OpenClaw register entry point.
 *
 * `import register from "@everme/openclaw"` returns this default
 * export, which OpenClaw calls at boot to install the EverMe context
 * engine into its plugin host.
 */

import { createRequire } from "node:module";
import { createContextEngine } from "./src/engine.js";

const require = createRequire(import.meta.url);
const pluginMeta = require("./openclaw.plugin.json");

export default function register(api) {
  const log = api?.logger || {
    info: (...a) => console.log(...a),
    warn: (...a) => console.warn(...a),
  };
  log.info(`[${pluginMeta.id}] Registering EverMe ContextEngine`);

  api.registerContextEngine(pluginMeta.id, (factoryConfig) => {
    // OpenClaw (registry-*.js: resolveContextEngine) passes factoryConfig as
    //   { config: <ENTIRE openclaw.json>, agentDir, workspaceDir }
    // — `factoryConfig.config` is the *whole* host config, not the plugin's
    // own block. The plugin's settings live at
    //   config.plugins.entries[pluginMeta.id].config
    // (this is also where `evercli plugin install openclaw` writes them).
    // resolveConfig in @everme/agent-sdk reads flat keys (host.agentId), so
    // we must dig in first; otherwise assertConfigUsable throws and OpenClaw
    // silently demotes to its legacy engine and EverMe is never called.
    //
    // Fall-back chain (in order):
    //   1. plugins.entries[id].config from whole openclaw.json  ← current OpenClaw
    //   2. factoryConfig.config if it already looks flat (agentId at top)
    //      — guards against hypothetical OpenClaw builds that pre-unwrap
    //   3. factoryConfig itself if it's flat — direct invocations / tests
    //   4. api.pluginConfig — older OpenClaw / register-time injection
    //   5. {} — let resolveConfig fall through to env (EVERME_AGENT_*)
    const wholeConfig = factoryConfig?.config;
    const pluginCfgFromWhole =
      wholeConfig?.plugins?.entries?.[pluginMeta.id]?.config;
    const wholeLooksFlat =
      wholeConfig &&
      (typeof wholeConfig.agentId === "string" ||
        typeof wholeConfig.agentToken === "string");
    const hostCfg =
      pluginCfgFromWhole ??
      (wholeLooksFlat ? wholeConfig : undefined) ??
      factoryConfig ??
      api.pluginConfig ??
      {};
    return createContextEngine(pluginMeta, hostCfg, api.logger);
  });
}
