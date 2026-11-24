import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createTelemetry,
  hookDegradedEvent,
  turnDeliveryEvent,
  TELEMETRY_PATH,
} from "../index.js";
import { MIN_TELEMETRY_BUDGET_MS, telemetryTimeoutMs } from "../src/hooks/telemetry.js";

function recordingClient(impl) {
  const calls = [];
  return {
    calls,
    async requestWithMeta(method, path, body, opts) {
      calls.push({ method, path, body, opts });
      if (impl) return impl();
      return { result: { ok: true }, requestId: "req-1" };
    },
  };
}

describe("telemetry events", () => {
  test("each event carries only the fields the server lets it own", () => {
    const turn = turnDeliveryEvent({ outcome: "lost_prev" });
    assert.deepEqual(turn, { event: "turn_delivery", channel: "hooks", outcome: "lost_prev" });
    assert.equal("hookEvent" in turn, false, "turn_delivery must not carry hookEvent");

    const degraded = hookDegradedEvent({ hookEvent: "Stop", code: "50301" });
    assert.deepEqual(degraded, { event: "hook_degraded", channel: "hooks", hookEvent: "Stop", code: "50301" });
    assert.equal("outcome" in degraded, false, "hook_degraded must not carry an outcome");
  });

  test("no event carries a platform: the gateway derives it from the agent row", () => {
    assert.equal("platform" in turnDeliveryEvent({ outcome: "ok" }), false);
    assert.equal("platform" in hookDegradedEvent({ hookEvent: "Stop" }), false);
  });
});

describe("telemetry reporting", () => {
  test("posts the event with a send timestamp", async () => {
    const client = recordingClient();
    const sent = await createTelemetry({ client, config: {}, now: () => 1_700_000_000_000 })
      .report(turnDeliveryEvent({ outcome: "ok" }));

    assert.equal(sent, true);
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].method, "POST");
    assert.equal(client.calls[0].path, TELEMETRY_PATH);
    assert.deepEqual(client.calls[0].body, {
      event: "turn_delivery",
      channel: "hooks",
      outcome: "ok",
      ts: 1_700_000_000_000,
    });
  });

  test("a failing report is swallowed, never thrown at the hook", async () => {
    const client = recordingClient(() => {
      throw new Error("gateway down");
    });
    const sent = await createTelemetry({ client, config: {} }).report(turnDeliveryEvent({ outcome: "ok" }));
    assert.equal(sent, false);
  });

  test("EVERME_TELEMETRY=0 stops the client from reporting at all", async () => {
    const client = recordingClient();
    const telemetry = createTelemetry({ client, config: { telemetry: false } });

    assert.equal(telemetry.enabled, false);
    assert.equal(await telemetry.report(turnDeliveryEvent({ outcome: "ok" })), false);
    assert.equal(client.calls.length, 0);
  });

  test("the report is dropped rather than eating the last of the hook budget", async () => {
    const now = 1_700_000_000_000;
    const client = recordingClient();
    const telemetry = createTelemetry({
      client,
      config: { deadlineAt: now + 200 },
      now: () => now,
    });

    assert.equal(await telemetry.report(turnDeliveryEvent({ outcome: "ok" })), false);
    assert.equal(client.calls.length, 0, "a turn matters more than the report about it");
  });

  test("a report inside the budget is clamped to what is left", async () => {
    const now = 1_700_000_000_000;
    const client = recordingClient();
    await createTelemetry({ client, config: { deadlineAt: now + 1_800 }, now: () => now })
      .report(turnDeliveryEvent({ outcome: "ok" }));

    assert.equal(client.calls[0].opts.timeoutMs, 1_800);
  });

  test("timeout budget: full when undeadlined, clamped inside it, zero below the floor", () => {
    const now = 1_000_000;
    assert.equal(telemetryTimeoutMs(0, now), 2_000);
    assert.equal(telemetryTimeoutMs(now + 10_000, now), 2_000);
    assert.equal(telemetryTimeoutMs(now + MIN_TELEMETRY_BUDGET_MS, now), MIN_TELEMETRY_BUDGET_MS);
    assert.equal(telemetryTimeoutMs(now + MIN_TELEMETRY_BUDGET_MS - 1, now), 0);
  });
});
