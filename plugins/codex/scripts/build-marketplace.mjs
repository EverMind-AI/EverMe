import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evermeBinDir = path.resolve(packageDir, "..", "everme", "bin");
const memoryPackage = JSON.parse(
  await readFile(path.resolve(packageDir, "..", "memory-mcp", "package.json"), "utf8"),
);
// esbuild bundles src/adapter.js into this same output file, so its
// createRequire(import.meta.url)("../package.json") would resolve against
// the bundle's own path (evermeBinDir), not codex's source tree, and
// throw MODULE_NOT_FOUND at runtime. Inject the version as a build-time
// constant instead — same fix as __EVERME_MCP_VERSION__ below.
const codexPackage = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));

await mkdir(evermeBinDir, { recursive: true });

for (const [entryPoint, fileName] of [
  [path.join(packageDir, "bin", "hook.js"), "hook.mjs"],
  [path.resolve(packageDir, "..", "memory-mcp", "bin", "mcp-server.js"), "memory-mcp.mjs"],
]) {
  const outputPath = path.join(evermeBinDir, fileName);
  await build({
    entryPoints: [entryPoint],
    outfile: outputPath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    legalComments: "none",
    charset: "utf8",
    sourcemap: false,
    minify: false,
    define:
      fileName === "memory-mcp.mjs"
        ? { __EVERME_MCP_VERSION__: JSON.stringify(memoryPackage.version) }
        : fileName === "hook.mjs"
          ? { __EVERME_CODEX_VERSION__: JSON.stringify(codexPackage.version) }
          : {},
  });
  const body = await readFile(outputPath, "utf8");
  await writeFile(outputPath, body.replace(/[ \t]+$/gm, ""), "utf8");
  await chmod(outputPath, 0o755);
}
