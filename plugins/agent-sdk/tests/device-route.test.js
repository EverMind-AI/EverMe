import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient, EvermeError } from "../src/client.js";
import { readDeviceRoute } from "../src/config.js";

function listen(handler) {
  const srv = http.createServer(handler);
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      resolve({ port: srv.address().port, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}

function okServer(label, seen) {
  return listen((req, res) => {
    seen.push(`${label} ${req.url}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "ok", status: 0, requestId: "r", result: { from: label } }));
  });
}

describe("device route", () => {
  let home;
  let saved;

  beforeEach(() => {
    saved = process.env.EVERME_MEMORY_HOME;
    home = mkdtempSync(join(tmpdir(), "everme-route-"));
    process.env.EVERME_MEMORY_HOME = home;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.EVERME_MEMORY_HOME;
    else process.env.EVERME_MEMORY_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  const writeRoute = (body) =>
    writeFileSync(join(home, "route.json"), typeof body === "string" ? body : JSON.stringify(body));

  test("no route file means the cloud", () => {
    assert.equal(readDeviceRoute(), null);
  });

  test("a local route sends requests to its loopback gateway", () => {
    writeRoute({ mode: "local", apiBase: "http://127.0.0.1:18791/" });
    assert.deepEqual(readDeviceRoute(), { baseUrl: "http://127.0.0.1:18791/api/v1" });
  });

  test("a local route carries the recall floor of its backend", () => {
    writeRoute({ mode: "local", apiBase: "http://127.0.0.1:18791", injectMinScore: 0.1 });
    assert.deepEqual(readDeviceRoute(), { baseUrl: "http://127.0.0.1:18791/api/v1", injectMinScore: 0.1 });
  });

  test("a recall floor outside 0..1 or not a number is ignored", () => {
    for (const bad of ["0.1", -0.1, 1.5, null, true]) {
      writeRoute({ mode: "local", apiBase: "http://127.0.0.1:18791", injectMinScore: bad });
      assert.deepEqual(readDeviceRoute(), { baseUrl: "http://127.0.0.1:18791/api/v1" }, String(bad));
    }
  });

  test("a route that is not local means the cloud", () => {
    writeRoute({ mode: "cloud", apiBase: "http://127.0.0.1:18791" });
    assert.equal(readDeviceRoute(), null);
  });

  test("a corrupt route file fails closed to the default gateway", () => {
    for (const body of ["{not json", "null", "[]", '"local"']) {
      writeRoute(body);
      assert.deepEqual(readDeviceRoute(), { baseUrl: "http://127.0.0.1:18790/api/v1" }, body);
    }
  });

  test("a route that points off this machine fails closed to the default gateway", () => {
    for (const apiBase of ["https://api.everme.evermind.ai", "http://10.0.0.5:18790", "http://127.0.0.1:18790/x", 42]) {
      writeRoute({ mode: "local", apiBase });
      assert.deepEqual(readDeviceRoute(), { baseUrl: "http://127.0.0.1:18790/api/v1" }, String(apiBase));
    }
  });

  test("an unreadable route file fails closed to the default gateway", { skip: process.getuid?.() === 0 }, () => {
    writeRoute({ mode: "local", apiBase: "http://127.0.0.1:18791" });
    chmodSync(join(home, "route.json"), 0o000);
    assert.deepEqual(readDeviceRoute(), { baseUrl: "http://127.0.0.1:18790/api/v1" });
  });

  test("the client follows a switch between requests without a new client", async () => {
    const seen = [];
    const cloud = await okServer("cloud", seen);
    const local = await okServer("local", seen);
    try {
      const client = createClient({ baseUrl: `http://127.0.0.1:${cloud.port}/api/v1`, agentToken: "evt_x", agentId: "agt_1" });
      assert.deepEqual(await client.request("POST", "/mem/search", {}), { from: "cloud" });

      writeRoute({ mode: "local", apiBase: `http://127.0.0.1:${local.port}` });
      assert.deepEqual(await client.request("POST", "/mem/search", {}), { from: "local" });

      rmSync(join(home, "route.json"));
      assert.deepEqual(await client.request("POST", "/mem/search", {}), { from: "cloud" });
      assert.deepEqual(seen, ["cloud /api/v1/mem/search", "local /api/v1/mem/search", "cloud /api/v1/mem/search"]);
    } finally {
      await cloud.close();
      await local.close();
    }
  });

  test("a stopped gateway fails the request instead of reaching the cloud", async () => {
    const seen = [];
    const cloud = await okServer("cloud", seen);
    const parked = await listen(() => {});
    const deadPort = parked.port;
    await parked.close();
    try {
      writeRoute({ mode: "local", apiBase: `http://127.0.0.1:${deadPort}` });
      const client = createClient({ baseUrl: `http://127.0.0.1:${cloud.port}/api/v1`, agentToken: "evt_x", agentId: "agt_1" });
      await assert.rejects(
        () => client.request("POST", "/mem/agent-memory", { messages: [] }),
        (err) => {
          assert.ok(err instanceof EvermeError);
          assert.match(err.message, /local memory service is not reachable/);
          assert.match(err.message, /open EverMe Desktop/);
          return true;
        },
      );
      assert.deepEqual(seen, []);
    } finally {
      await cloud.close();
    }
  });

  // EverOS has no desktop app: its gateway is a service evercli runs.
  test("a stopped EverOS gateway points at evercli, not EverMe Desktop", async () => {
    const parked = await listen(() => {});
    const deadPort = parked.port;
    await parked.close();
    writeRoute({ mode: "local", apiBase: `http://127.0.0.1:${deadPort}` });
    const client = createClient({ baseUrl: "http://127.0.0.1:9/api/v1", agentToken: "evt_x", agentId: "agt_1", brand: "everos" });
    await assert.rejects(
      () => client.request("POST", "/mem/agent-memory", { messages: [] }),
      (err) => {
        assert.match(err.message, /local memory service is not reachable/);
        assert.doesNotMatch(err.message, /EverMe/);
        assert.match(err.message, /evercli doctor/);
        return true;
      },
    );
  });
});
