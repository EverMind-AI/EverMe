/**
 * Credential loading for the OpenCode / Kilo Code plugin.
 *
 * `evercli plugin install opencode|kilocode` writes `everme.env` at 0600 next
 * to the host's config and passes its path to the plugin as the `envFile`
 * option of the `plugin` config entry. The plugin runs inside the host
 * process, so it must NOT mutate process.env: the host spawns tools and
 * shell commands from that environment, and an agent token there would leak
 * into every child process.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const KEYS = ["EVERME_API_BASE", "EVERME_AGENT_ID", "EVERME_AGENT_TOKEN", "EVERME_BRAND", "EVERME_MEMORY_HOME"];

export function defaultEnvFile(env = process.env) {
  const configHome = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "opencode", "everme.env");
}

export function envFilePath(options = {}, env = process.env) {
  // Each plugin entry names its own file; the two brands' instances share
  // one process env, so the option comes first.
  return (typeof options.envFile === "string" && options.envFile) || env.EVERME_ENV_FILE_PATH || defaultEnvFile(env);
}

export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text || "").split("\n")) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!KEYS.includes(key)) continue;
    out[key] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * Returns { configured, agentId, agentToken, apiBase, path, reason }.
 * `configured` false is a normal state: events then skip silently.
 */
export async function loadCredentials(options = {}, env = process.env) {
  const path = envFilePath(options, env);
  let parsed = {};
  let reason = "";
  try {
    parsed = parseEnvFile(await readFile(path, "utf8"));
  } catch (error) {
    reason = error?.code === "ENOENT" ? "missing" : "unreadable";
  }
  // A file that names its brand (EverOS) owns every key it sets, so exported
  // EverMe credentials cannot be mixed with it. An EverMe file keeps the
  // exported values first.
  const pick = (key) => (parsed.EVERME_BRAND ? parsed[key] || env[key] : env[key] || parsed[key]) || "";
  const agentId = pick("EVERME_AGENT_ID");
  const agentToken = pick("EVERME_AGENT_TOKEN");
  const apiBase = pick("EVERME_API_BASE");
  const configured = Boolean(agentId && agentToken);
  return {
    configured,
    agentId,
    agentToken,
    apiBase,
    // Brand and memory home are this instance's own: an EverMe and an EverOS
    // instance can run in one host process, so neither reads process.env.
    brand: parsed.EVERME_BRAND || "",
    memoryHome: parsed.EVERME_MEMORY_HOME || "",
    path,
    reason: configured ? "" : reason || "incomplete",
  };
}
