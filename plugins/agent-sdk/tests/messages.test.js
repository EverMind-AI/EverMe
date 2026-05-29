import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toText, stripChannelMetadata, isSessionResetPrompt } from "../src/messages.js";
import { buildMemoryPrompt } from "../src/prompt.js";

describe("messages.toText", () => {
  test("plain string passes through", () => {
    assert.equal(toText("hello"), "hello");
  });
  test("part array joined with newlines", () => {
    assert.equal(toText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
  });
  test("nested object with .text", () => {
    assert.equal(toText({ text: "x" }), "x");
  });
  test("undefined / null safe", () => {
    assert.equal(toText(null), "");
    assert.equal(toText(undefined), "");
  });
  test("strips channel envelope from string content", () => {
    const enveloped =
      'Sender (untrusted metadata):\n```json\n{"label": "openclaw-feishu", "sender_id": "ou_xxx"}\n```\n\nWhat is the postgres index decision?';
    assert.equal(toText(enveloped), "What is the postgres index decision?");
  });
  test("strips channel envelope from part-array content", () => {
    const parts = [
      { type: "text", text: 'Sender (untrusted metadata):\n```json\n{"x":1}\n```' },
      { type: "text", text: "remember my preference" },
    ];
    assert.equal(toText(parts), "remember my preference");
  });
});

describe("messages.stripChannelMetadata", () => {
  test("removes Sender (untrusted metadata) fenced block", () => {
    const input = 'Sender (untrusted metadata):\n```json\n{"id":"u1"}\n```\n\nhello';
    assert.equal(stripChannelMetadata(input), "hello");
  });
  test("removes Conversation info block", () => {
    const input = "Conversation info:\n```\n{x}\n```\nquery text";
    assert.equal(stripChannelMetadata(input), "query text");
  });
  test("removes Chinese 发送者 variant", () => {
    const input = "发送者 (untrusted metadata):\n```json\n{}\n```\n你好";
    assert.equal(stripChannelMetadata(input), "你好");
  });
  test("removes [message_id: ...] line and follow-up sender_id", () => {
    const input = "[message_id: 1778645118]\nsender_id: ou_abc\nactual question";
    assert.equal(stripChannelMetadata(input), "actual question");
  });
  test("strips leading timestamp prefix", () => {
    const input = "[Mon 2026-05-13 22:16 GMT+8] real content";
    assert.equal(stripChannelMetadata(input), "real content");
  });
  test("no envelope → returns input trimmed", () => {
    assert.equal(stripChannelMetadata("just text"), "just text");
  });
  test("null/empty safe", () => {
    assert.equal(stripChannelMetadata(""), "");
    assert.equal(stripChannelMetadata(null), null);
    assert.equal(stripChannelMetadata(undefined), undefined);
  });
});

describe("messages.isSessionResetPrompt", () => {
  test("/clear and /reset detected", () => {
    assert.equal(isSessionResetPrompt("/clear"), true);
    assert.equal(isSessionResetPrompt("/reset"), true);
    assert.equal(isSessionResetPrompt("/new"), true);
  });
  test("trailing args still match", () => {
    assert.equal(isSessionResetPrompt("/clear please"), true);
  });
  test("normal queries don't trip", () => {
    assert.equal(isSessionResetPrompt("what's my project status?"), false);
    assert.equal(isSessionResetPrompt(""), false);
  });
});

describe("prompt.buildMemoryPrompt", () => {
  test("renders rows as markdown bullets", () => {
    const out = buildMemoryPrompt([
      { type: "episodic_memory", summary: "user asked X" },
      { type: "profile", text: "prefers Go" },
    ]);
    assert.match(out, /## Relevant memory/);
    assert.match(out, /\[episodic\] user asked X/);
    assert.match(out, /\[profile\] prefers Go/);
  });
  test("empty list returns empty string", () => {
    assert.equal(buildMemoryPrompt([]), "");
  });
  test("wrapInCodeBlock wraps with ```memory fence", () => {
    const out = buildMemoryPrompt(
      [{ summary: "x" }],
      { wrapInCodeBlock: true },
    );
    assert.match(out, /^```memory/);
    assert.match(out, /```$/);
  });
});
