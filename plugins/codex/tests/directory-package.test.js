import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginsRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceDirectory = path.join(pluginsRoot, "codex-directory");
const packageScript = path.join(pluginsRoot, "scripts/package-codex-directory.mjs");
const expectedScopes = ["mem:read", "mem:search", "mem:write", "openid", "email"];

function fixture(context) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "everme-directory-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source");
  cpSync(sourceDirectory, source, { recursive: true });
  return { directory, source };
}

function pack(source, output) {
  return spawnSync(process.execPath, [packageScript, "--source", source, "--output", output], {
    encoding: "utf8",
  });
}

test("directory MCP declares OpenAI OAuth with DCR and all required scopes", () => {
  const configuration = JSON.parse(readFileSync(path.join(sourceDirectory, ".mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(configuration.mcpServers), ["everme-memory"]);
  assert.deepEqual(configuration.mcpServers["everme-memory"], {
    url: "https://api.everme.evermind.ai/mcp",
    extensions: {
      "com.openai": {
        auth: {
          type: "oauth",
          client: { mode: "dcr" },
          baseScopes: expectedScopes,
        },
      },
    },
  });
});

test("directory plugin name differs from the hook plugin", () => {
  const manifest = JSON.parse(readFileSync(path.join(sourceDirectory, ".codex-plugin/plugin.json"), "utf8"));
  const hookManifest = JSON.parse(readFileSync(path.join(pluginsRoot, "everme/.codex-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.name, "everme-memory");
  assert.notEqual(manifest.name, hookManifest.name);
});

test("packager rejects the legacy x-auth declaration", (context) => {
  const { directory, source } = fixture(context);
  writeFileSync(path.join(source, ".mcp.json"), JSON.stringify({ mcpServers: { "everme-memory": {
    url: "https://api.everme.evermind.ai/mcp",
    extensions: { "x-auth": { type: "oauth", bearer: { client: { mode: "dcr" }, baseScopes: expectedScopes } } },
  } } }));
  const result = pack(source, path.join(directory, "output"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OAuth/);
});

test("packager creates a root-level plugin ZIP and matching checksum", (context) => {
  const { directory, source } = fixture(context);
  writeFileSync(path.join(source, ".DS_Store"), "excluded");
  const result = pack(source, path.join(directory, "output"));
  assert.equal(result.status, 0, result.stderr);
  const metadata = JSON.parse(result.stdout);
  const archive = readFileSync(metadata.archive);
  assert.equal(metadata.sha256, createHash("sha256").update(archive).digest("hex"));
  assert.equal(readFileSync(`${metadata.archive}.sha256`, "utf8"), `${metadata.sha256}  ${path.basename(metadata.archive)}\n`);
  const entries = execFileSync("unzip", ["-Z1", metadata.archive], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(entries, [
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "README.md",
    "assets/everme-logo.png",
    "skills/everme-memory/SKILL.md",
  ]);
  const embeddedMcp = execFileSync("unzip", ["-p", metadata.archive, ".mcp.json"], { encoding: "utf8" });
  assert.equal(embeddedMcp, readFileSync(path.join(source, ".mcp.json"), "utf8"));
  const second = pack(source, path.join(directory, "second"));
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).sha256, metadata.sha256);
});

test("packager rejects missing OAuth declarations", (context) => {
  const { directory, source } = fixture(context);
  writeFileSync(path.join(source, ".mcp.json"), JSON.stringify({ mcpServers: { "everme-memory": { url: "https://api.everme.evermind.ai/mcp" } } }));
  const result = pack(source, path.join(directory, "output"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OAuth/);
});

test("packager rejects symlinked package files", (context) => {
  const { directory, source } = fixture(context);
  const readme = path.join(source, "README.md");
  rmSync(readme);
  symlinkSync(path.join(sourceDirectory, "README.md"), readme);
  const result = pack(source, path.join(directory, "output"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /regular file/);
});

test("packager rejects credentials in package content", (context) => {
  const { directory, source } = fixture(context);
  writeFileSync(path.join(source, "README.md"), `Unexpected credential: ${"evt_"}${"a".repeat(32)}\n`);
  const result = pack(source, path.join(directory, "output"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /credential/i);
  assert.doesNotMatch(result.stderr, /evt_a/);
});
