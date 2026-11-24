#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

const entries = [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "README.md",
  "assets/everme-logo.png",
  "skills/everme-memory/SKILL.md",
];
const scopes = ["mem:read", "mem:search", "mem:write", "openid", "email"];

function packagePlugin(source, output) {
  const files = new Map(entries.map((entry) => {
    let component = source;
    for (const segment of entry.split("/")) {
      component = path.join(component, segment);
      assert.ok(!lstatSync(component).isSymbolicLink(), `Expected a regular file path: ${entry}`);
    }
    assert.ok(lstatSync(component).isFile(), `Expected a regular file: ${entry}`);
    const content = readFileSync(component);
    assert.ok(!/(?:evt_|emk_)[A-Za-z0-9_-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content.toString("utf8")), `Possible credential in ${entry}`);
    return [entry, content];
  }));
  const manifest = JSON.parse(files.get(".codex-plugin/plugin.json"));
  const configuration = JSON.parse(files.get(".mcp.json"));
  assert.equal(manifest.name, "everme-memory");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.interface.logo, "./assets/everme-logo.png");
  assert.equal(manifest.interface.composerIcon, "./assets/everme-logo.png");
  for (const field of ["hooks", "commands", "agents", "apps"]) {
    assert.ok(!(field in manifest), `Unsupported directory plugin component: ${field}`);
  }
  assert.ok(isDeepStrictEqual(configuration, {
    mcpServers: {
      "everme-memory": {
        url: "https://api.everme.evermind.ai/mcp",
        extensions: {
          "com.openai": {
            auth: { type: "oauth", client: { mode: "dcr" }, baseScopes: scopes },
          },
        },
      },
    },
  }), "OAuth configuration must declare DCR and the required scopes without credentials");

  mkdirSync(output, { recursive: true });
  const archive = path.join(output, `everme-openai-${manifest.version}.zip`);
  assert.ok(!existsSync(archive), "Output archive already exists; choose an empty output directory");
  const staging = mkdtempSync(path.join(os.tmpdir(), "everme-directory-package-"));
  try {
    const timestamp = new Date("2000-01-01T00:00:00Z");
    for (const [entry, content] of files) {
      const destination = path.join(staging, entry);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, content, { mode: 0o644 });
      utimesSync(destination, timestamp, timestamp);
    }
    const stagedArchive = path.join(staging, "plugin.zip");
    execFileSync("zip", ["-X", "-q", stagedArchive, ...entries], { cwd: staging, env: { ...process.env, TZ: "UTC" } });
    const bytes = readFileSync(stagedArchive);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    renameSync(stagedArchive, archive);
    writeFileSync(`${archive}.sha256`, `${sha256}  ${path.basename(archive)}\n`);
    return { archive, version: manifest.version, sha256, bytes: bytes.length, files: entries };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

try {
  const { values } = parseArgs({ options: { source: { type: "string" }, output: { type: "string" } } });
  assert.ok(values.output, "Provide --output with a local delivery directory");
  const source = path.resolve(values.source ?? fileURLToPath(new URL("../codex-directory/", import.meta.url)));
  process.stdout.write(`${JSON.stringify(packagePlugin(source, path.resolve(values.output)), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`Package validation failed: ${error.message}\n`);
  process.exitCode = 1;
}
