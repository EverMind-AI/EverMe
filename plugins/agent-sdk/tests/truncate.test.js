import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { capRunes, MAX_CONTENT_RUNES } from "../src/truncate.js";

// Count Unicode code points (what the server counts as "runes"), NOT UTF-16
// code units (what String.prototype.length / .slice operate on).
const codePoints = (s) => [...s].length;

describe("capRunes", () => {
  test("default cap is the server's 8000-rune gate", () => {
    assert.equal(MAX_CONTENT_RUNES, 8000);
  });

  test("short text passes through unchanged", () => {
    const s = "a short message";
    assert.equal(capRunes(s), s);
  });

  test("long text is truncated to <= cap CODE POINTS (not 32000, not UTF-16 length)", () => {
    const s = "x".repeat(25000);
    const out = capRunes(s);
    assert.ok(
      codePoints(out) <= MAX_CONTENT_RUNES,
      `expected <= ${MAX_CONTENT_RUNES} code points, got ${codePoints(out)}`,
    );
  });

  test("keeps head AND tail with a middle marker (not head-only)", () => {
    const head = "HEAD_SENTINEL_BEGIN";
    const tail = "TAIL_SENTINEL_END";
    const out = capRunes(head + "x".repeat(25000) + tail);
    assert.ok(out.includes(head), "head must be preserved");
    assert.ok(out.includes(tail), "tail must be preserved (head+tail, not head-only)");
    assert.ok(out.includes("trimmed"), "expected a middle-trim marker");
  });

  test("counts by code points, never splits a surrogate pair", () => {
    // 😀 is one code point but two UTF-16 units. 6000 of them = 6000 code
    // points (<= 8000) so it must pass through untouched and stay valid.
    const emoji = "😀".repeat(6000);
    const out = capRunes(emoji);
    assert.equal(out, emoji, "6000 code points <= cap must pass through");
    // No lone surrogate (� would appear if a pair were split).
    assert.ok(!out.includes("�"), "must not split a surrogate pair");

    // 9000 emoji = 9000 code points > cap → truncated to <= 8000 code points.
    const big = "😀".repeat(9000);
    const outBig = capRunes(big);
    assert.ok(codePoints(outBig) <= MAX_CONTENT_RUNES);
    assert.ok(!outBig.includes("�"), "truncation must not split a surrogate pair");
  });
});
