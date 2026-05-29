"use strict";
// Copyright 2026 Evermind AI
// SPDX-License-Identifier: Apache-2.0

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const {
  getExpectedChecksum,
  verifyChecksum,
  assertAllowedHost,
  assertInsideDir,
  resolveMirrorUrls,
} = require("../scripts/install.js");

test("resolveMirrorUrls falls back to npmmirror by default", () => {
  const urls = resolveMirrorUrls({});
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/registry\.npmmirror\.com\/-\/binary\/everme-cli\//);
});

test("resolveMirrorUrls prepends derived path for non-default registry", () => {
  const urls = resolveMirrorUrls({ npm_config_registry: "https://corp.example.com/npm/" });
  assert.equal(urls.length, 2);
  assert.match(urls[0], /^https:\/\/corp\.example\.com\/npm\/-\/binary\/everme-cli\//);
  assert.match(urls[1], /^https:\/\/registry\.npmmirror\.com\/-\/binary\/everme-cli\//);
});

test("resolveMirrorUrls skips default npmjs registry (it doesn't host binaries)", () => {
  const urls = resolveMirrorUrls({ npm_config_registry: "https://registry.npmjs.org/" });
  assert.equal(urls.length, 1);
  assert.match(urls[0], /npmmirror\.com/);
});

test("resolveMirrorUrls ignores http-only / malformed registries", () => {
  const urls1 = resolveMirrorUrls({ npm_config_registry: "http://insecure.example.com/" });
  assert.equal(urls1.length, 1, "http should be rejected");
  const urls2 = resolveMirrorUrls({ npm_config_registry: "not-a-url" });
  assert.equal(urls2.length, 1, "garbage should be rejected");
});

test("assertAllowedHost passes for github.com", () => {
  assert.doesNotThrow(() =>
    assertAllowedHost("https://github.com/EverMind-AI/EverMe/releases/download/v0.1.0/x"),
  );
});

test("assertAllowedHost rejects unknown hosts", () => {
  assert.throws(
    () => assertAllowedHost("https://evil.example.com/payload"),
    /Download host not allowed: evil\.example\.com/,
  );
});

test("getExpectedChecksum parses a sha256sums.txt entry", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "everme-cli-test-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "sha256sums.txt"),
      "abcdef1234567890  evercli_darwin_arm64.tar.gz\n" +
        "fedcba0987654321  evercli_linux_amd64.tar.gz\n",
    );
    assert.equal(
      getExpectedChecksum("evercli_darwin_arm64.tar.gz", tmp),
      "abcdef1234567890",
    );
    assert.equal(
      getExpectedChecksum("evercli_linux_amd64.tar.gz", tmp),
      "fedcba0987654321",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("getExpectedChecksum throws when entry missing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "everme-cli-test-"));
  try {
    fs.writeFileSync(path.join(tmp, "sha256sums.txt"), "abc  evercli_darwin_arm64.tar.gz\n");
    assert.throws(
      () => getExpectedChecksum("evercli_windows_amd64.zip", tmp),
      /Checksum entry not found/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("getExpectedChecksum hard-fails when sha256sums.txt is missing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "everme-cli-test-"));
  try {
    assert.throws(
      () => getExpectedChecksum("anything", tmp),
      /sha256sums\.txt missing/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("verifyChecksum accepts matching hash and rejects mismatch", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "everme-cli-test-"));
  try {
    const file = path.join(tmp, "sample.bin");
    const payload = Buffer.from("hello world");
    fs.writeFileSync(file, payload);
    const expected = crypto.createHash("sha256").update(payload).digest("hex");
    assert.doesNotThrow(() => verifyChecksum(file, expected));
    assert.throws(
      () => verifyChecksum(file, "0".repeat(64)),
      /Checksum mismatch/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("assertInsideDir accepts a regular file inside the dir", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "everme-cli-test-"));
  try {
    const file = path.join(tmp, "evercli");
    fs.writeFileSync(file, "hello");
    assert.doesNotThrow(() => assertInsideDir(tmp, file));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("assertInsideDir rejects a symlink that escapes the dir", () => {
  if (process.platform === "win32") return; // symlinks require admin/dev mode
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "everme-cli-test-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "everme-cli-outside-"));
  try {
    const target = path.join(outside, "secret");
    fs.writeFileSync(target, "secret");
    const link = path.join(tmp, "evercli");
    fs.symlinkSync(target, link);
    assert.throws(
      () => assertInsideDir(tmp, link),
      /not a regular file|escapes archive root/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
