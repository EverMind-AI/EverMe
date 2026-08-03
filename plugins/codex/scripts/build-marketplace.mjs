import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.resolve(packageDir, "..", "everme", "bin", "hook.mjs");

await mkdir(path.dirname(outputPath), { recursive: true });
await build({
  entryPoints: [path.join(packageDir, "bin", "hook.js")],
  outfile: outputPath,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  legalComments: "none",
  charset: "utf8",
  sourcemap: false,
  minify: false,
});
await chmod(outputPath, 0o755);
