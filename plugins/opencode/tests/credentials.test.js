import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { envFilePath, loadCredentials } from "../src/credentials.js";

describe("opencode credentials", () => {
  it("reads the env file named by the plugin option", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "everme-opencode-"));
    const file = path.join(dir, "everme.env");
    await writeFile(file, "EVERME_API_BASE=http://x\nEVERME_AGENT_ID=agt_1\nEVERME_AGENT_TOKEN=evt_1\n", { mode: 0o600 });
    const creds = await loadCredentials({ envFile: file }, {});
    assert.equal(creds.configured, true);
    assert.equal(creds.agentId, "agt_1");
    assert.equal(creds.apiBase, "http://x");
  });

  it("prefers the option, then EVERME_ENV_FILE_PATH, then the opencode default", () => {
    // Both brands' plugin instances share one process env, so each must read
    // the file its own entry names.
    assert.equal(envFilePath({ envFile: "/a" }, { EVERME_ENV_FILE_PATH: "/b" }), "/a");
    assert.equal(envFilePath({}, { EVERME_ENV_FILE_PATH: "/b" }), "/b");
    assert.equal(envFilePath({ envFile: "/a" }, {}), "/a");
    assert.equal(envFilePath({}, { XDG_CONFIG_HOME: "/cfg" }), path.join("/cfg", "opencode", "everme.env"));
  });

  it("lets a brand file win over every exported key, and keeps exported keys first for an EverMe file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "everme-opencode-"));
    const exported = { EVERME_AGENT_ID: "agt_env", EVERME_AGENT_TOKEN: "evt_env", EVERME_API_BASE: "https://exported" };
    const everos = path.join(dir, "everos.env");
    await writeFile(everos, "EVERME_API_BASE=http://127.0.0.1:47391\nEVERME_AGENT_ID=agt_os\nEVERME_AGENT_TOKEN=evt_os\nEVERME_BRAND=everos\n", { mode: 0o600 });
    const os1 = await loadCredentials({ envFile: everos }, exported);
    assert.deepEqual([os1.agentId, os1.agentToken, os1.apiBase], ["agt_os", "evt_os", "http://127.0.0.1:47391"]);
    const everme = path.join(dir, "everme.env");
    await writeFile(everme, "EVERME_API_BASE=https://api.everme.evermind.ai\nEVERME_AGENT_ID=agt_me\nEVERME_AGENT_TOKEN=evt_me\n", { mode: 0o600 });
    const me = await loadCredentials({ envFile: everme }, exported);
    assert.deepEqual([me.agentId, me.agentToken, me.apiBase], ["agt_env", "evt_env", "https://exported"]);
    const plain = await loadCredentials({ envFile: everme }, {});
    assert.deepEqual([plain.agentId, plain.agentToken, plain.apiBase], ["agt_me", "evt_me", "https://api.everme.evermind.ai"]);
  });

  it("reports a missing file as not configured", async () => {
    const creds = await loadCredentials({ envFile: "/nonexistent/everme.env" }, {});
    assert.equal(creds.configured, false);
    assert.equal(creds.reason, "missing");
  });
});
