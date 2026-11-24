import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isEvermeMemoryTool, saveAgentMemory } from "@everme/agent-sdk";
import { readCanonicalTranscript } from "../src/transcript.js";

const RECALL_PAYLOAD = "```memory\n## Relevant memory\n- [Preferences] RECALLED-ONLY\n```";
// The same fence quoted by a real shell command: content markers are therefore
// not a usable discriminator, only provenance is.
const SHELL_PAYLOAD = "docs.md:1: ```memory\n## Relevant memory\n- [Preferences] SHELL-QUOTED\n```";

function item(payload, ts) {
  return JSON.stringify({ type: "response_item", timestamp: ts, payload });
}

describe("EverMe memory MCP traffic", () => {
  // The list must match what the memory MCP server actually exposes: mem_skill
  // hands back a whole extracted agent skill.
  test("covers the memory MCP tool surface", () => {
    for (const name of ["mem_context", "mem_search", "mem_skill", "mem_save_turn", "mem_save_fact"]) {
      assert.equal(isEvermeMemoryTool({ name }), true, `${name} is not recognised as EverMe's`);
    }
    assert.equal(isEvermeMemoryTool({ name: "mem_search", namespace: "mcp__other_memory" }), false);
  });

  test("its calls and results never reach the upload, while real tool traffic survives", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "everme-inject-"));
    try {
      const rollout = path.join(dir, "rollout.jsonl");
      await writeFile(rollout, [
        JSON.stringify({ type: "session_meta", timestamp: 1749003000000, payload: { id: "01a02e4c-3f42-7192-8c34-9418008e9f22", history_mode: "paginated" } }),
        item({ type: "message", role: "user", content: [{ type: "input_text", text: "check this deck" }] }, 1749003001000),
        // Matched by namespace.
        item({ type: "function_call", name: "mem_search", namespace: "mcp__everme", call_id: "c-mem", arguments: '{"query":"deck"}' }, 1749003002000),
        item({ type: "function_call_output", call_id: "c-mem", output: RECALL_PAYLOAD }, 1749003003000),
        // Generic resource tool, matched by the server in its arguments.
        item({ type: "function_call", name: "read_mcp_resource", call_id: "c-res", arguments: '{"server":"everme","uri":"mem://profile"}' }, 1749003004000),
        item({ type: "function_call_output", call_id: "c-res", output: '{"server":"everme","uri":"mem://profile"}' }, 1749003005000),
        // Another server's resource read must survive.
        item({ type: "function_call", name: "read_mcp_resource", call_id: "c-gh", arguments: '{"server":"github","uri":"repo://x"}' }, 1749003006000),
        item({ type: "function_call_output", call_id: "c-gh", output: "github said hello" }, 1749003007000),
        // A real shell command whose output quotes the memory fence must survive.
        item({ type: "function_call", name: "exec_command", call_id: "c-sh", arguments: '{"cmd":"grep -rn memory ."}' }, 1749003008000),
        item({ type: "function_call_output", call_id: "c-sh", output: SHELL_PAYLOAD }, 1749003009000),
        // Review !476 P2: another server's tool of the same name must survive.
        item({ type: "function_call", name: "mem_search", namespace: "mcp__other_memory", call_id: "c-other", arguments: '{"query":"deck"}' }, 1749003010000),
        item({ type: "function_call_output", call_id: "c-other", output: "other memory said hello" }, 1749003011000),
        item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }, 1749003012000),
        "",
      ].join("\n"));

      // Assert on what actually goes out: the shared write layer is where the
      // filter lives, so a transcript-only check would prove nothing.
      const sent = [];
      await saveAgentMemory({ async request(method, path, body) { sent.push(body); return {}; } }, {
        conversationId: "codex-session", messages: await readCanonicalTranscript(rollout), flush: false,
      });
      const blob = JSON.stringify(sent[0].messages);
      assert.equal(blob.includes("namespace"), false, "source-local provenance must not reach the wire");
      for (const gone of ["c-mem", "c-res", "mem://profile", "RECALLED-ONLY"]) {
        assert.equal(blob.includes(gone), false, `EverMe memory traffic ${gone} reached the upload`);
      }
      for (const kept of ["c-gh", "github said hello", "c-sh", "SHELL-QUOTED", "c-other", "other memory said hello", "check this deck", "done"]) {
        assert.equal(blob.includes(kept), true, `legitimate content ${kept} was dropped`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
