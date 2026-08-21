import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "../index.js";
import { runHostHook } from "../src/hooks/runtime.js";
import {
  boundedTimeoutMs,
  HOOK_SAFETY_MARGIN_MS,
  HOST_HOOK_TIMEOUT_S,
  hookBudgetMs,
  MIN_REQUEST_BUDGET_MS,
  startHookWatchdog,
  TIMEOUT_MS,
} from "../index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginsRoot = path.resolve(here, "..", "..");

// Regression for the 2026-08-17 review item 1.1.7. The host kills a hook
// at its manifest timeout; the SDK's own request timeout was set to the
// same 30s, so the abort path could never win the race - the process was
// killed mid-flight, the turn counter never committed, no diagnostic was
// written, and the turn was gone for good (the next Stop reads only the
// new last turn). The in-process budget must always finish first.
describe("hook deadline budget", () => {
  test("every hook budget leaves the host room to hear back", () => {
    for (const [event, seconds] of Object.entries(HOST_HOOK_TIMEOUT_S)) {
      const budget = hookBudgetMs(event);
      assert.ok(budget > 0, `${event} must have a positive budget`);
      assert.ok(
        budget < seconds * 1000,
        `${event}: budget ${budget}ms must be strictly under the host's ${seconds}s kill deadline`,
      );
      assert.equal(budget, seconds * 1000 - HOOK_SAFETY_MARGIN_MS);
    }
  });

  test("UserPromptSubmit is the tightest budget, and the default request timeout blows it", () => {
    // The recall hook gets 10s from the host while the SDK default is 30s:
    // a 3:1 mismatch, worse than Stop's 1:1.
    assert.ok(hookBudgetMs("UserPromptSubmit") < TIMEOUT_MS);
  });

  test("an unknown event has no budget rather than a made-up one", () => {
    assert.equal(hookBudgetMs("NotAHostEvent"), null);
  });

  test("a request never outlives the remaining budget", () => {
    const now = 1_000_000;
    // Plenty of budget left: the configured timeout still applies.
    assert.equal(boundedTimeoutMs(TIMEOUT_MS, now + 60_000, now), TIMEOUT_MS);
    // Less budget than the configured timeout: the deadline wins.
    assert.equal(boundedTimeoutMs(TIMEOUT_MS, now + 5_000, now), 5_000);
    // Nearly out of budget: never go to zero or negative, or fetch would
    // abort instantly and we would report a timeout we caused ourselves.
    assert.equal(boundedTimeoutMs(TIMEOUT_MS, now + 10, now), MIN_REQUEST_BUDGET_MS);
    assert.equal(boundedTimeoutMs(TIMEOUT_MS, now - 5_000, now), MIN_REQUEST_BUDGET_MS);
    // No deadline configured: unchanged.
    assert.equal(boundedTimeoutMs(TIMEOUT_MS, null, now), TIMEOUT_MS);
  });

  test("two sequential requests share one budget instead of each getting a fresh one", () => {
    // A flush turn issues enqueue then flush. With a shared deadline the
    // second request gets what the first left, so the pair cannot exceed
    // the host's budget the way two independent 30s timeouts could.
    const now = 1_000_000;
    const deadlineAt = now + hookBudgetMs("Stop");
    const first = boundedTimeoutMs(TIMEOUT_MS, deadlineAt, now);
    const afterFirst = now + first;
    const second = boundedTimeoutMs(TIMEOUT_MS, deadlineAt, afterFirst);
    assert.ok(first + second <= hookBudgetMs("Stop") + MIN_REQUEST_BUDGET_MS);
  });
});

describe("hook watchdog", () => {
  // The watchdog is the backstop for a hook wedged past its own abort
  // path, not a competitor to it: it must fire AFTER the request deadline
  // (or it kills a request that was about to finish and preempts the
  // fail-open handling that commits state and writes the diagnostic) and
  // before the host kill (or it never fires at all). Even the last-gasp
  // request boundedTimeoutMs grants past the deadline gets
  // MIN_REQUEST_BUDGET_MS, so the watchdog must sit beyond that too.
  test("fires between the request deadline and the host kill", () => {
    let scheduled = null;
    const budgetMs = hookBudgetMs("Stop");
    const stop = startHookWatchdog({
      budgetMs,
      onExpire: () => {},
      setTimer: (fn, ms) => {
        scheduled = ms;
        return 1;
      },
      clearTimer: () => {},
    });
    assert.ok(
      scheduled > budgetMs + MIN_REQUEST_BUDGET_MS,
      `watchdog at ${scheduled}ms would preempt a request still allowed until ${budgetMs + MIN_REQUEST_BUDGET_MS}ms`,
    );
    assert.ok(
      scheduled < budgetMs + HOOK_SAFETY_MARGIN_MS,
      `watchdog at ${scheduled}ms fires after the host kill at ${budgetMs + HOOK_SAFETY_MARGIN_MS}ms`,
    );
    stop();
  });

  test("holds that ordering for the tightest budget too", () => {
    let scheduled = null;
    const budgetMs = hookBudgetMs("UserPromptSubmit");
    startHookWatchdog({
      budgetMs,
      onExpire: () => {},
      setTimer: (fn, ms) => {
        scheduled = ms;
        return 1;
      },
      clearTimer: () => {},
    });
    assert.ok(scheduled > budgetMs + MIN_REQUEST_BUDGET_MS, `watchdog at ${scheduled}ms`);
    assert.ok(scheduled < budgetMs + HOOK_SAFETY_MARGIN_MS, `watchdog at ${scheduled}ms`);
  });

  test("reports which hook ran out of time, without a token", () => {
    let reported = "";
    let fire = null;
    startHookWatchdog({
      event: "Stop",
      budgetMs: 27_000,
      onExpire: (line) => {
        reported = line;
      },
      setTimer: (fn) => {
        fire = fn;
        return 1;
      },
      clearTimer: () => {},
    });
    fire();
    assert.match(reported, /Stop/);
    assert.doesNotMatch(reported, /evt_/);
  });

  test("no budget means no watchdog", () => {
    let scheduled = false;
    startHookWatchdog({
      budgetMs: null,
      onExpire: () => {},
      setTimer: () => {
        scheduled = true;
        return 1;
      },
      clearTimer: () => {},
    });
    assert.equal(scheduled, false);
  });

  test("stopping it clears the timer so a fast hook exits immediately", () => {
    let cleared = null;
    const stop = startHookWatchdog({
      budgetMs: 27_000,
      onExpire: () => {},
      setTimer: () => 42,
      clearTimer: (handle) => {
        cleared = handle;
      },
    });
    stop();
    assert.equal(cleared, 42);
  });
});

// The bug was two numbers meaning the same thing living in two files. A
// manifest that drifts from the SDK table puts them back out of sync, so
// assert them against each other.
describe("host manifests match the SDK timeout table", () => {
  test("claude-code hooks.json", async () => {
    const raw = await readFile(path.join(pluginsRoot, "claude-code", "hooks", "hooks.json"), "utf8");
    const { hooks } = JSON.parse(raw);
    for (const [event, matchers] of Object.entries(hooks)) {
      for (const matcher of matchers) {
        for (const entry of matcher.hooks) {
          assert.equal(
            entry.timeout,
            HOST_HOOK_TIMEOUT_S[event],
            `${event} manifest timeout must match HOST_HOOK_TIMEOUT_S`,
          );
        }
      }
    }
  });

  test("kimicode kimi.plugin.json", async () => {
    const raw = await readFile(path.join(pluginsRoot, "kimicode", "kimi.plugin.json"), "utf8");
    const { hooks } = JSON.parse(raw);
    for (const entry of hooks) {
      assert.equal(
        entry.timeout,
        HOST_HOOK_TIMEOUT_S[entry.event],
        `${entry.event} manifest timeout must match HOST_HOOK_TIMEOUT_S`,
      );
    }
  });
});

// The wiring, not just the arithmetic: a hook must hand the client a
// deadline and the client must honour it. Without this, each request
// still gets its own full 30s and a flush turn can spend 60s against a
// 30s host budget.
describe("runtime hands the client a deadline", () => {
  test("Stop config carries a deadline inside the host budget", async () => {
    let seenConfig = null;
    const before = Date.now();
    await runHostHook(
      "Stop",
      { sessionId: "s1", turnId: "t1" },
      {
        envFile: () => undefined,
        normalizeInput: async (raw) => raw,
        formatOutput: (event, result) => ({ event, ...result }),
      },
      {
        baseEnv: {},
        resolveConfig: () => ({ isConfigured: true, authMode: "evt", agentId: "agt_test" }),
        createClient: (cfg) => {
          seenConfig = cfg;
          return { id: "client" };
        },
        createTurnCounter: () => ({
          peek: async () => ({ duplicate: false }),
          commit: async () => ({ count: 1 }),
        }),
        runStore: async () => ({ block: "", count: 0 }),
      },
    );
    assert.ok(seenConfig?.deadlineAt, "createClient must receive a deadlineAt");
    // Measured from before the call, so the deadline is at least the
    // budget away and — the property that matters — still comfortably
    // inside the host's kill deadline.
    const budget = seenConfig.deadlineAt - before;
    assert.ok(budget >= hookBudgetMs("Stop"), `deadline is short: ${budget}ms`);
    assert.ok(
      budget < HOST_HOOK_TIMEOUT_S.Stop * 1000,
      `deadline must land inside the host's ${HOST_HOOK_TIMEOUT_S.Stop}s kill window, got ${budget}ms`,
    );
  });

  test("the client aborts on the deadline instead of waiting out its own 30s", async () => {
    const budgetMs = 1_500;
    const client = createClient(
      {
        baseUrl: "https://example.invalid/api/v1",
        agentToken: "evt_test",
        agentId: "agt_test",
        deadlineAt: Date.now() + budgetMs,
      },
      { info() {}, warn() {} },
    );

    // A request that never answers: only the abort can end it.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")));
      });

    const started = Date.now();
    let error;
    try {
      await client.request("POST", "/mem/agent-memory", { conversationId: "s1" });
    } catch (err) {
      error = err;
    } finally {
      globalThis.fetch = realFetch;
    }
    const waited = Date.now() - started;

    assert.ok(error, "a hung request must surface an error, not hang the hook");
    assert.match(String(error.message), /timed out/);
    assert.ok(
      waited < TIMEOUT_MS / 2,
      `must abort on the ${budgetMs}ms deadline, waited ${waited}ms`,
    );
  });
});
