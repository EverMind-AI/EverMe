import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { redactError } from "../hooks/scripts/lib/redact.js";

describe("redactError", () => {
  test("scrubs evt and emk tokens", () => {
    const got = redactError(
      "Authorization: Bearer evt_abcdef0123456789abcdef0123456789 — failed; emk_FFFFFFFF11111111aaaaaaaa22222222 also leaked",
    );
    assert.ok(!got.includes("evt_abcdef0123456789abcdef0123456789"), "evt full token redacted");
    assert.ok(!got.includes("emk_FFFFFFFF11111111aaaaaaaa22222222"), "emk full token redacted");
    assert.ok(got.includes("evt_abcd_REDACTED"), "evt prefix preserved for grep");
    assert.ok(got.includes("emk_FFFF_REDACTED"), "emk prefix preserved for grep");
  });

  test("scrubs S3 signing query params", () => {
    const url =
      "https://bucket.s3/path?X-Amz-Signature=deadbeef&X-Amz-Credential=ASIAUSW5VCSR6PNKTWY3/20260430&foo=bar";
    const got = redactError("upload failed: " + url);
    assert.ok(!got.includes("deadbeef"), "X-Amz-Signature value redacted");
    assert.ok(!got.includes("ASIAUSW5VCSR6PNKTWY3"), "credential value redacted");
    assert.ok(got.includes("X-Amz-Signature=[REDACTED]"));
    assert.ok(got.includes("foo=bar"), "non-secret params preserved");
  });

  test("scrubs bare AWS access key ids", () => {
    const got = redactError("creds = AKIA1234567890ABCDEF + AKIA1234567890ABCDEF");
    assert.ok(!got.includes("AKIA1234567890ABCDEF"), "AKIA value redacted");
    assert.ok(got.includes("[REDACTED-AWSKEY]"));
  });

  test("returns empty string on null", () => {
    assert.equal(redactError(null), "");
    assert.equal(redactError(undefined), "");
  });

  test("accepts Error objects (uses .message)", () => {
    const e = new Error("evt_abcdef0123456789abcdef0123456789 in stack");
    const got = redactError(e);
    assert.ok(!got.includes("evt_abcdef0123456789abcdef0123456789"));
  });
});
