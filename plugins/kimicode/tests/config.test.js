import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, _resetCache } from "../hooks/scripts/lib/config.js";

const ORIG_ENV = { ...process.env };
let dir;

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("EVERME_")) delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "everme-kimi-config-"));
  process.env.EVERME_ENV_FILE_PATH = join(dir, "everme.env");
  _resetCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("EVERME_")) delete process.env[k];
  }
  Object.assign(process.env, ORIG_ENV);
  _resetCache();
});

// The MCP launcher reads this config. An EverMe variable exported in the
// shell must not send the token of an EverOS install to EverMe.
test("a brand env file owns every key it sets over the process env", () => {
  process.env.EVERME_API_BASE = "https://exported.example";
  writeFileSync(process.env.EVERME_ENV_FILE_PATH, "EVERME_API_BASE=http://127.0.0.1:47391\nEVERME_AGENT_TOKEN=evt_x\nEVERME_BRAND=everos\n");
  assert.equal(getConfig().baseUrl, "http://127.0.0.1:47391/api/v1");
});

test("an EverMe env file keeps the process env override for the API base", () => {
  process.env.EVERME_API_BASE = "https://exported.example";
  writeFileSync(process.env.EVERME_ENV_FILE_PATH, "EVERME_API_BASE=https://api.everme.evermind.ai\nEVERME_AGENT_TOKEN=evt_x\n");
  assert.equal(getConfig().baseUrl, "https://exported.example/api/v1");
});
