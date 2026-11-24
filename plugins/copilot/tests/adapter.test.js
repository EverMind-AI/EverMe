import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { copilotAdapter, copilotConfigDir, sessionEventsPath } from "../src/adapter.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures", "copilot-events.jsonl");
const LIVE_FIXTURE = path.join(here, "fixtures", "copilot-cli-session.jsonl");

function memoryCheckpointStore() {
  const rows = new Map();
  return {
    rows,
    async read(stateId) {
      return rows.get(stateId) || { initialized: false, uploadedCount: 0 };
    },
    async commit(stateId, uploadedCount, extra = {}) {
      rows.set(stateId, { initialized: true, uploadedCount, ...extra });
    },
  };
}

function withEnv(values, fn) {
  const previous = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("copilot adapter", () => {
  it("maps the camelCase config-file events onto the SDK lifecycle", () => {
    assert.equal(copilotAdapter.mapEvent("sessionStart"), "SessionStart");
    assert.equal(copilotAdapter.mapEvent("userPromptSubmitted"), "UserPromptSubmit");
    assert.equal(copilotAdapter.mapEvent("agentStop"), "Stop");
    assert.equal(copilotAdapter.mapEvent("sessionEnd"), "Stop");
  });

  it("reads the camelCase stdin Copilot CLI sends", () => {
    const input = copilotAdapter.normalizeInput({
      sessionId: "s-1",
      timestamp: 1793095544774,
      cwd: "/w",
      transcriptPath: "/x/events.jsonl",
      stopReason: "end_turn",
      stop_hook_active: false,
    });
    assert.equal(input.sessionId, "s-1");
    assert.equal(input.transcriptPath, "/x/events.jsonl");
    assert.equal(copilotAdapter.normalizeInput({}).sessionId, "");
    assert.equal(copilotAdapter.normalizeInput(null).transcriptPath, "");
  });

  it("derives the events file for sessionEnd, which carries no transcriptPath", () => {
    withEnv({ EVERCLI_COPILOT_CONFIG_DIR: "/tmp/cp", COPILOT_HOME: undefined }, () => {
      const input = copilotAdapter.normalizeInput({ sessionId: "s-2", reason: "complete" });
      assert.equal(input.transcriptPath, path.join("/tmp/cp", "session-state", "s-2", "events.jsonl"));
      assert.equal(sessionEventsPath("s-2"), input.transcriptPath);
    });
  });

  it("resolves the config dir and env file", () => {
    withEnv({ EVERCLI_COPILOT_CONFIG_DIR: undefined, COPILOT_HOME: undefined, EVERME_ENV_FILE_PATH: undefined }, () => {
      assert.equal(copilotConfigDir(), path.join(os.homedir(), ".copilot"));
      assert.equal(copilotAdapter.envFile(), path.join(os.homedir(), ".copilot", "everme.env"));
    });
    withEnv({ EVERCLI_COPILOT_CONFIG_DIR: undefined, COPILOT_HOME: "/tmp/home", EVERME_ENV_FILE_PATH: undefined }, () => {
      assert.equal(copilotAdapter.envFile(), path.join("/tmp/home", "everme.env"));
    });
    withEnv({ EVERCLI_COPILOT_CONFIG_DIR: "/tmp/explicit", COPILOT_HOME: "/tmp/home", EVERME_ENV_FILE_PATH: undefined }, () => {
      assert.equal(copilotAdapter.envFile(), path.join("/tmp/explicit", "everme.env"));
    });
  });

  it("returns top-level additionalContext only for the two context events", () => {
    const block = "<everme_recall>x</everme_recall>";
    assert.deepEqual(copilotAdapter.formatOutput("sessionStart", { block }), { additionalContext: block });
    assert.deepEqual(copilotAdapter.formatOutput("userPromptSubmitted", { block }), { additionalContext: block });
    assert.deepEqual(copilotAdapter.formatOutput("agentStop", { block }), {});
    assert.deepEqual(copilotAdapter.formatOutput("sessionStart", { block: "" }), {});
  });

  it("uploads only the newest turn on the first capture after install", async () => {
    const store = memoryCheckpointStore();
    const [batch] = await copilotAdapter.readStoreBatches({ sessionId: "s-1", transcriptPath: FIXTURE }, { checkpointStore: store });
    assert.equal(batch.messages[0].content, "Read both files at once.");
    assert.equal(batch.messages.length, 5);
    assert.equal(batch.deduplication, "client-native-id");
    assert.equal(batch.channel, "hook");
    assert.equal(batch.checkpoint.stateId, "copilot-cli:s-1");
    assert.equal(batch.baseTurn, undefined, "a cold-start tail claims no absolute turn");
    assert.equal(store.rows.get("copilot-cli:s-1").nativeMessageIds.length, 4, "earlier records are the excluded baseline");
  });

  it("uploads nothing when the checkpoint already holds every record", async () => {
    const store = memoryCheckpointStore();
    const [batch] = await copilotAdapter.readStoreBatches({ sessionId: "s-1", transcriptPath: FIXTURE }, { checkpointStore: store });
    await store.commit(batch.checkpoint.stateId, batch.checkpoint.uploadedCount, { nativeMessageIds: batch.checkpoint.nativeMessageIds });
    assert.deepEqual(await copilotAdapter.readStoreBatches({ sessionId: "s-1", transcriptPath: FIXTURE }, { checkpointStore: store }), []);
  });

  it("resumes from the start when an earlier capture of the session died", async () => {
    const [batch] = await copilotAdapter.readStoreBatches(
      { sessionId: "s-1", transcriptPath: FIXTURE },
      { checkpointStore: memoryCheckpointStore(), resumeFromStart: true },
    );
    assert.equal(batch.messages.length, 9);
    assert.equal(batch.baseTurn, 0);
    assert.equal(batch.turns, 2);
  });

  it("uploads a live session's second turn as a delta after its first", async () => {
    const store = memoryCheckpointStore();
    const input = { sessionId: "s-live", transcriptPath: LIVE_FIXTURE };
    const [full] = await copilotAdapter.readStoreBatches(input, { checkpointStore: store, resumeFromStart: true });
    assert.equal(full.messages.length, 9);
    assert.equal(full.turns, 2);
    const firstTurn = full.checkpoint.nativeMessageIds.slice(0, 4);
    await store.commit(full.checkpoint.stateId, 4, { nativeMessageIds: firstTurn });
    const [delta] = await copilotAdapter.readStoreBatches(input, { checkpointStore: store });
    assert.equal(delta.messages.length, 5);
    assert.equal(delta.baseTurn, 1);
    assert.equal(delta.turns, 1);
  });

  it("declares a per-turn boundary", () => {
    assert.equal(copilotAdapter.turnBoundary, "stop");
    assert.equal(copilotAdapter.platform, "copilot-cli");
  });
});
