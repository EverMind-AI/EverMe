import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readLastTurn, readSession, wirePath } from "../hooks/scripts/lib/kimi-transcript.js";

// Kimi Code names each session's bucket dir `wd_<slug>_<hash12>` where hash12 =
// sha256(cwd)[:12] and the slug PRESERVES hyphens (its encodeWorkDirKey). The
// plugin used to reconstruct the slug with its own rule (hyphens -> "_"), so for
// any cwd whose basename has a hyphen the reconstructed path missed the real
// dir, readWireLines returned [], and the write hook silently persisted nothing.
// The hash12 suffix is identical on both sides, so locating the bucket by hash
// is drift-proof.
test("readLastTurn locates wire.jsonl under a hyphen-slug workdir dir (encodeWorkDirKey drift)", async () => {
  const home = mkdtempSync(join(tmpdir(), "kimi-home-"));
  const prevHome = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = home;
  try {
    const cwd = "/Users/x/code/my-proj"; // hyphen in basename
    const sessionId = "session_abc-123";
    const hash12 = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
    // Kimi keeps the hyphen: wd_my-proj_<hash12> (NOT wd_my_proj_<hash12>).
    const dir = join(home, "sessions", `wd_my-proj_${hash12}`, sessionId, "agents", "main");
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      type: "context.append_message",
      time: 1700000000000,
      message: { role: "user", origin: { kind: "user" }, content: [{ type: "text", text: "hello glob" }] },
    });
    writeFileSync(join(dir, "wire.jsonl"), line + "\n");

    const tail = await readLastTurn({ sessionId, cwd });
    assert.equal(tail.length, 1, "should locate the transcript despite slug drift");
    assert.equal(tail[0].role, "user");
    assert.equal(tail[0].content, "hello glob");
  } finally {
    if (prevHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// A per-turn writer uploads only the last turn (thin), which produces agent
// cases but rarely an episode. The SessionEnd handler needs the WHOLE session
// so the backend has enough coherent context to extract an episodic memory.
// readSession returns every turn; lastTurn returns only the final one.
test("readSession returns the full multi-turn session, unlike lastTurn", async () => {
  const home = mkdtempSync(join(tmpdir(), "kimi-home-"));
  const prev = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = home;
  try {
    const cwd = "/Users/x/code/proj";
    const sessionId = "session_multi";
    const hash12 = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
    const dir = join(home, "sessions", `wd_proj_${hash12}`, sessionId, "agents", "main");
    mkdirSync(dir, { recursive: true });
    const L = [
      { type: "context.append_message", time: 1700000000000, message: { role: "user", origin: { kind: "user" }, content: [{ type: "text", text: "first question" }] } },
      { type: "context.append_loop_event", time: 1700000001000, event: { type: "content.part", turnId: 0, step: 1, part: { type: "text", text: "first answer" } } },
      { type: "context.append_loop_event", time: 1700000001500, event: { type: "step.end", turnId: 0, step: 1 } },
      { type: "context.append_message", time: 1700000002000, message: { role: "user", origin: { kind: "user" }, content: [{ type: "text", text: "second question" }] } },
      { type: "context.append_loop_event", time: 1700000003000, event: { type: "content.part", turnId: 1, step: 1, part: { type: "text", text: "second answer" } } },
      { type: "context.append_loop_event", time: 1700000003500, event: { type: "step.end", turnId: 1, step: 1 } },
    ].map((o) => JSON.stringify(o)).join("\n");
    writeFileSync(join(dir, "wire.jsonl"), L + "\n");

    const full = await readSession({ sessionId, cwd });
    const tail = await readLastTurn({ sessionId, cwd });
    assert.equal(full.length, 4, "full session = 2 user + 2 assistant");
    assert.equal(full.filter((m) => m.role === "user").length, 2, "both user turns present");
    assert.equal(full[0].content, "first question", "session starts at the first turn");
    assert.ok(full.length > tail.length, "readSession must be a superset of the last turn");
  } finally {
    if (prev === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
