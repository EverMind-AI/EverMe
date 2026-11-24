import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EvermeError, deliveryAgentRef, deliveryFailReason, recordDelivery } from "../index.js";

describe("delivery status", () => {
  let home;
  let saved;

  beforeEach(() => {
    saved = { memoryHome: process.env.EVERME_MEMORY_HOME, home: process.env.HOME };
    home = mkdtempSync(join(tmpdir(), "everme-delivery-"));
    process.env.EVERME_MEMORY_HOME = home;
  });

  afterEach(() => {
    if (saved.memoryHome === undefined) delete process.env.EVERME_MEMORY_HOME;
    else process.env.EVERME_MEMORY_HOME = saved.memoryHome;
    if (saved.home === undefined) delete process.env.HOME;
    else process.env.HOME = saved.home;
    rmSync(home, { recursive: true, force: true });
  });

  const read = (dir, name) => JSON.parse(readFileSync(join(dir, "delivery", name), "utf8"));

  test("agent_ref is the first 16 hex characters of SHA-256 over the agent id", () => {
    assert.equal(deliveryAgentRef("agt_0123456789abcdef"), "a58b8fb7581c597a");
  });

  test("writes one file per host and kind under EVERME_MEMORY_HOME", () => {
    const before = Date.now();
    recordDelivery("dsh", "fail", { reason: "http_5xx", pluginVersion: "1.2.3", agentId: "agt_0123456789abcdef" });
    const body = read(home, "dsh.fail.json");
    assert.deepEqual(Object.keys(body), ["schema", "at", "reason", "plugin_version", "agent_ref"]);
    assert.equal(body.schema, 1);
    assert.equal(body.reason, "http_5xx");
    assert.equal(body.plugin_version, "1.2.3");
    assert.equal(body.agent_ref, "a58b8fb7581c597a");
    assert.match(body.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(Date.parse(body.at) >= before && Date.parse(body.at) <= Date.now());
    assert.deepEqual(readdirSync(join(home, "delivery")), ["dsh.fail.json"]);
  });

  test("a later record replaces the whole file and an outcome without a reason stores null", () => {
    recordDelivery("dsh", "ok", { reason: "stale", pluginVersion: "1.0.0", agentId: "agt_a" });
    recordDelivery("dsh", "ok", { pluginVersion: "1.0.1", agentId: "agt_b" });
    const body = read(home, "dsh.ok.json");
    assert.equal(body.reason, null);
    assert.equal(body.plugin_version, "1.0.1");
    assert.equal(body.agent_ref, deliveryAgentRef("agt_b"));
    assert.deepEqual(readdirSync(join(home, "delivery")), ["dsh.ok.json"]);
  });

  test("falls back to ~/.everme/memory without EVERME_MEMORY_HOME", () => {
    delete process.env.EVERME_MEMORY_HOME;
    process.env.HOME = home;
    recordDelivery("dsh", "skip", { reason: "session_unreadable", agentId: "agt_a" });
    assert.equal(read(join(home, ".everme", "memory"), "dsh.skip.json").reason, "session_unreadable");
  });

  test("a failed write is logged and never thrown", () => {
    writeFileSync(join(home, "delivery"), "not a directory");
    const warnings = [];
    recordDelivery("dsh", "ok", { agentId: "agt_a" }, { warn: line => warnings.push(line) });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /delivery status not recorded host=dsh kind=ok/);
    recordDelivery("dsh", "ok", { agentId: "agt_a" });
  });

  test("fail reasons map in order to the closed set", () => {
    const cases = [
      [new EvermeError({ message: "denied", status: 401, type: "auth" }), "auth"],
      [new EvermeError({ message: "slow", type: "timeout" }), "timeout"],
      [new EvermeError({ message: "missing", status: 404 }), "http_4xx"],
      [new EvermeError({ message: "down", status: 503 }), "http_5xx"],
      [new EvermeError({ message: "refused", status: 0 }), "network"],
      [new Error("boom"), "other"],
      [new EvermeError({ message: "envelope", status: 200, code: 50000 }), "other"],
      [new Error("wrapped", { cause: new EvermeError({ message: "down", status: 502 }) }), "http_5xx"],
      [undefined, "other"],
    ];
    for (const [error, reason] of cases) assert.equal(deliveryFailReason(error), reason);
  });
});
