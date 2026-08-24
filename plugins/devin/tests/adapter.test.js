import { describe, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { stashPrompt } from "../src/pending-prompt.js";
import { fileURLToPath } from "node:url";
import { devinAdapter } from "../src/adapter.js";

const transcriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "devin-transcript.jsonl");

describe("Devin hook adapter", () => {
  test("maps only the transcript response event to Stop", () => {
    assert.equal(devinAdapter.mapEvent("post_cascade_response_with_transcript"), "Stop");
    assert.equal(devinAdapter.mapEvent("pre_user_prompt"), "pre_user_prompt");
  });

  test("normalizes the official common and tool fields", async () => {
    assert.deepEqual(await devinAdapter.normalizeInput({
      agent_action_name: "post_cascade_response_with_transcript",
      trajectory_id: "devin-trajectory",
      execution_id: "devin-execution",
      timestamp: "2026-07-14T02:00:00.000Z",
      model_name: "Claude Sonnet 4",
      tool_info: { transcript_path: transcriptPath },
    }, "post_cascade_response_with_transcript"), {
      sessionId: "devin-trajectory",
      turnId: "devin-execution",
      event: "post_cascade_response_with_transcript",
      toolInfo: { transcript_path: transcriptPath },
      transcriptPath,
      timestamp: "2026-07-14T02:00:00.000Z",
      modelName: "Claude Sonnet 4",
    });
  });

  test("reads the latest conversational turn", async () => {
    assert.deepEqual(await devinAdapter.readLastTurn({ transcriptPath }), [
      { role: "user", content: "create a hello world file" },
      { role: "assistant", content: "I'll create a hello world file for you." },
      { role: "assistant", content: "I created the file for you." },
    ]);
  });

  // A real session emitted post_cascade_response and post_run_command and
  // never post_cascade_response_with_transcript, so those two are what the
  // adapter has to turn into a stored turn.
  test("treats the events Devin actually emits as turn boundaries", () => {
    assert.equal(devinAdapter.mapEvent("post_cascade_response"), "Stop");
    assert.equal(devinAdapter.mapEvent("post_run_command"), "Stop");
  });

  test("carries the event and tool_info through normalizeInput", () => {
    const input = devinAdapter.normalizeInput({
      agent_action_name: "post_run_command",
      trajectory_id: "traj-1",
      execution_id: "exec-1",
      tool_info: { command_line: "ls", cwd: "/tmp" },
    }, "post_run_command");
    assert.equal(input.sessionId, "traj-1");
    assert.equal(input.turnId, "exec-1");
    assert.equal(input.event, "post_run_command");
    assert.deepEqual(input.toolInfo, { command_line: "ls", cwd: "/tmp" });
  });

  test("builds the turn from tool_info, pairing the stashed prompt", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "everme-devin-adapter-"));
    try {
      await stashPrompt("traj-1", "how many lines", { stateDir: dir });
      const previous = process.env.EVERME_STATE_DIR;
      process.env.EVERME_STATE_DIR = dir;
      try {
        const messages = await devinAdapter.readLastTurn({
          event: "post_cascade_response",
          sessionId: "traj-1",
          toolInfo: { response: "42" },
        });
        assert.deepEqual(messages, [
          { role: "user", content: "how many lines" },
          { role: "assistant", content: "42" },
        ]);
      } finally {
        if (previous === undefined) delete process.env.EVERME_STATE_DIR;
        else process.env.EVERME_STATE_DIR = previous;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Regression: turn.js used to read input.executionId, a field
  // normalizeInput never produces (it emits turnId), so every tool call
  // id silently fell back to the command line. Pipe the real normalized
  // input through, exactly as runStore does, to pin the id derivation.
  test("tool call ids come from execution_id, not the command line", async () => {
    const input = devinAdapter.normalizeInput({
      trajectory_id: "traj-1",
      execution_id: "exec-101",
      tool_info: { command_line: "echo hi", cwd: "/tmp" },
    }, "post_run_command");
    const messages = await devinAdapter.readLastTurn(input);
    assert.equal(messages[0].toolCalls[0].id, "devin_exec-101");
  });

  test("emits no output for asynchronous post hooks", () => {
    assert.deepEqual(devinAdapter.formatOutput("post_cascade_response_with_transcript", { block: "memory" }), {});
  });

  // Devin moved its user config from the Windsurf tree to ~/.config/devin
  // and prompts users to copy it across, so credentials can sit in either
  // place: the current location for a fresh install, the old one for an
  // install made before the move. Reading only one of them means the hook
  // starts up unconfigured and silently writes nothing.
  test("prefers Devin's current config directory for credentials", withHome((home) => {
    mkdirSync(path.join(home, ".config", "devin"), { recursive: true });
    writeFileSync(path.join(home, ".config", "devin", "everme.env"), "EVERME_AGENT_TOKEN=evt_x\n");
    mkdirSync(path.join(home, ".codeium", "windsurf"), { recursive: true });
    writeFileSync(path.join(home, ".codeium", "windsurf", "everme.env"), "EVERME_AGENT_TOKEN=evt_old\n");

    assert.equal(devinAdapter.envFile(), path.join(home, ".config", "devin", "everme.env"));
  }));

  test("falls back to the pre-move location when that is where the install is", withHome((home) => {
    mkdirSync(path.join(home, ".codeium", "windsurf"), { recursive: true });
    writeFileSync(path.join(home, ".codeium", "windsurf", "everme.env"), "EVERME_AGENT_TOKEN=evt_old\n");

    assert.equal(devinAdapter.envFile(), path.join(home, ".codeium", "windsurf", "everme.env"));
  }));

  test("with neither present, names the current location", withHome((home) => {
    assert.equal(devinAdapter.envFile(), path.join(home, ".config", "devin", "everme.env"));
  }));

  test("an explicit EVERME_ENV_FILE_PATH still wins", withHome((home) => {
    const explicit = path.join(home, "elsewhere.env");
    process.env.EVERME_ENV_FILE_PATH = explicit;
    try {
      assert.equal(devinAdapter.envFile(), explicit);
    } finally {
      delete process.env.EVERME_ENV_FILE_PATH;
    }
  }));
});

// withHome runs fn against a throwaway HOME so the assertions never
// depend on (or touch) the developer's real Devin install.
function withHome(fn) {
  return () => {
    const previousHome = process.env.HOME;
    const previousEnvFile = process.env.EVERME_ENV_FILE_PATH;
    delete process.env.EVERME_ENV_FILE_PATH;
    const home = mkdtempSync(path.join(os.tmpdir(), "everme-devin-home-"));
    process.env.HOME = home;
    try {
      fn(home);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousEnvFile !== undefined) process.env.EVERME_ENV_FILE_PATH = previousEnvFile;
      rmSync(home, { recursive: true, force: true });
    }
  };
}
