#!/usr/bin/env node
// Copyright 2026 Evermind AI
// SPDX-License-Identifier: Apache-2.0

/**
 * postinstall hook for @everme/cli — downloads, verifies, and extracts the
 * platform-native evercli binary into <pkg>/bin.
 *
 * Expected binary archive conventions:
 *
 *   repo     EverMind-AI/EverMe
 *   tag      vX.Y.Z
 *   archive  evercli_<os>_<arch>.tar.gz   (Unix)
 *            evercli_<os>_<arch>.zip      (Windows)
 *   checksum sha256sums.txt
 *
 * Why curl rather than node:https: matches install.sh, behaves consistently
 * across corporate proxies, and follows redirects without us reimplementing
 * the redirect chain.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const VERSION = require("../package.json").version;
const REPO = "EverMind-AI/EverMe";
const NAME = "evercli";

// Allowlist gates the *initial* request URL. curl --location follows redirects
// (capped by --max-redirs 3) without re-checking the target host. Acceptable
// because the SHA256 check on the downloaded archive is the primary integrity
// control; the allowlist is defense-in-depth against obviously wrong URLs.
const ALLOWED_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "registry.npmmirror.com",
]);

const PLATFORM_MAP = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};

const ARCH_MAP = {
  x64: "amd64",
  arm64: "arm64",
};

const platform = PLATFORM_MAP[process.platform];
const arch = ARCH_MAP[process.arch];

const isWindows = process.platform === "win32";
const ext = isWindows ? ".zip" : ".tar.gz";
const archiveName = `${NAME}_${platform}_${arch}${ext}`;

// Tag scheme is bare semver `vX.Y.Z`.
const TAG = `v${VERSION}`;
const GITHUB_URL = `https://github.com/${REPO}/releases/download/${TAG}/${archiveName}`;

const binDir = path.join(__dirname, "..", "bin");
const dest = path.join(binDir, NAME + (isWindows ? ".exe" : ""));

function joinUrl(base, suffix) {
  return base.replace(/\/+$/, "") + suffix;
}

function isValidDownloadBase(raw) {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" && !!parsed.hostname;
  } catch (_) {
    return false;
  }
}

function isDefaultNpmjsRegistry(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === "registry.npmjs.org";
  } catch (_) {
    return false;
  }
}

/**
 * Build the ordered list of binary mirror URLs to try.
 *
 *   1. npm_config_registry — when the user has set a non-default registry
 *      (npmmirror clone, corp Verdaccio, Artifactory), we prepend the
 *      derived path. The `everme-cli` segment is a binary mirror namespace,
 *      not a GitHub repository name. Many proxies don't host /-/binary/<pkg>/...,
 *      so we always append the public npmmirror as a final fallback.
 *   2. registry.npmmirror.com — public China mirror, always tried last.
 *
 * The default public npmjs registry is skipped because it doesn't host
 * binaries under /-/binary/...
 *
 * Non-https / malformed npm_config_registry is silently ignored so npm users
 * with http-only internal registries don't have their installs broken.
 */
function resolveMirrorUrls(env) {
  const binaryPath = `/-/binary/everme-cli/${TAG}/${archiveName}`;
  const defaultUrl = joinUrl("https://registry.npmmirror.com", binaryPath);

  const urls = [];
  const registry = (env.npm_config_registry || "").trim();
  if (registry && !isDefaultNpmjsRegistry(registry) && isValidDownloadBase(registry)) {
    const base = new URL(registry);
    urls.push(joinUrl(base.origin + base.pathname, binaryPath));
  }
  if (!urls.includes(defaultUrl)) urls.push(defaultUrl);
  return urls;
}

function getMirrorUrls(env) {
  const urls = resolveMirrorUrls(env);
  for (const u of urls) ALLOWED_HOSTS.add(new URL(u).hostname);
  return urls;
}

function assertAllowedHost(url) {
  const { hostname } = new URL(url);
  if (!ALLOWED_HOSTS.has(hostname)) {
    throw new Error(`Download host not allowed: ${hostname}`);
  }
}

function download(url, destPath) {
  assertAllowedHost(url);
  const args = [
    "--fail", "--location", "--silent", "--show-error",
    "--connect-timeout", "10", "--max-time", "120",
    "--max-redirs", "3",
    "--output", destPath,
  ];
  // On Windows (Schannel), avoid CRYPT_E_REVOCATION_OFFLINE errors when the
  // CRL server is unreachable.
  if (isWindows) args.unshift("--ssl-revoke-best-effort");
  args.push(url);
  execFileSync("curl", args, { stdio: ["ignore", "ignore", "pipe"] });
}

function extractZipWindows(archivePath, destDir) {
  const psOpts = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"];
  const psStdio = ["ignore", "inherit", "inherit"];
  const psEnv = {
    ...process.env,
    EVERME_CLI_ARCHIVE: archivePath,
    EVERME_CLI_DEST: destDir,
  };
  try {
    const dotnet =
      "$ErrorActionPreference='Stop';" +
      "Add-Type -AssemblyName System.IO.Compression.FileSystem;" +
      "[System.IO.Compression.ZipFile]::ExtractToDirectory($env:EVERME_CLI_ARCHIVE,$env:EVERME_CLI_DEST)";
    execFileSync("powershell.exe", [...psOpts, dotnet], { stdio: psStdio, env: psEnv });
  } catch (primaryErr) {
    try {
      const cmdlet =
        "$ErrorActionPreference='Stop';" +
        "Expand-Archive -LiteralPath $env:EVERME_CLI_ARCHIVE -DestinationPath $env:EVERME_CLI_DEST -Force";
      execFileSync("powershell.exe", [...psOpts, cmdlet], { stdio: psStdio, env: psEnv });
    } catch (fallbackErr) {
      throw new Error(
        `Failed to extract ${archivePath}. ` +
          `.NET ZipFile attempt: ${primaryErr.message}. ` +
          `Expand-Archive fallback: ${fallbackErr.message}`,
      );
    }
  }
}

/**
 * Look up the SHA256 checksum for the archive from sha256sums.txt that ships
 * inside this npm package. sha256sums.txt is listed in package.json::files,
 * so a real `npm install` will always include it. A missing file is either
 * a tampered tarball or a broken publish — in both cases skipping the check
 * defeats the integrity model, so we hard-fail instead of warning.
 *
 * The workspace dev-install path is already short-circuited above
 * (`__dirname.includes("/node_modules/")`), so this branch is only ever
 * reached for installs that MUST verify.
 */
function getExpectedChecksum(archive, checksumsDir) {
  const dir = checksumsDir || path.join(__dirname, "..");
  const checksumsPath = path.join(dir, "sha256sums.txt");
  if (!fs.existsSync(checksumsPath)) {
    throw new Error(
      `[SECURITY] sha256sums.txt missing at ${checksumsPath}; refusing to install ` +
        `an unverified binary. The file ships with the npm package — its absence ` +
        `indicates tampering or a broken release.`,
    );
  }
  const content = fs.readFileSync(checksumsPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // sha256sums.txt uses two-space separator: "<hash>  <filename>"
    const idx = trimmed.indexOf("  ");
    if (idx === -1) continue;
    const hash = trimmed.slice(0, idx);
    const name = trimmed.slice(idx + 2);
    if (name === archive) return hash;
  }
  throw new Error(`Checksum entry not found for ${archive}`);
}

/**
 * Defends against zip-slip: an archive can ship `evercli` as a symlink to
 * `/etc/passwd` (or any path outside tmpDir). copyFileSync follows symlinks,
 * so without this check the extracted "binary" we ship to <pkg>/bin could
 * be sourced from anywhere. lstat catches the symlink case (we reject non-
 * regular files); realpath resolves what the path actually points at and we
 * assert it stays within tmpDir.
 */
function assertInsideDir(dir, candidate) {
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile()) {
    throw new Error(
      `[SECURITY] Extracted entry is not a regular file (mode=${stat.mode.toString(8)}); ` +
        `refusing to install. Path: ${candidate}`,
    );
  }
  const realDir = fs.realpathSync(dir);
  const realCandidate = fs.realpathSync(candidate);
  const sep = path.sep;
  if (realCandidate !== realDir && !realCandidate.startsWith(realDir + sep)) {
    throw new Error(
      `[SECURITY] Extracted path escapes archive root: ${realCandidate} not under ${realDir}`,
    );
  }
  return realCandidate;
}

function verifyChecksum(archivePath, expectedHash) {
  // Stream to keep RSS constant; archives can be ~10MB+.
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(archivePath, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  const actual = hash.digest("hex");
  if (actual.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(
      `[SECURITY] Checksum mismatch for ${path.basename(archivePath)}: ` +
        `expected ${expectedHash} but got ${actual}`,
    );
  }
}

function install() {
  const mirrorUrls = getMirrorUrls(process.env);
  const downloadUrls = [GITHUB_URL, ...mirrorUrls];

  fs.mkdirSync(binDir, { recursive: true });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "everme-cli-"));
  const archivePath = path.join(tmpDir, archiveName);

  try {
    // Walk the chain in order; stop at the first success.
    let lastErr;
    let downloaded = false;
    for (const url of downloadUrls) {
      try {
        download(url, archivePath);
        downloaded = true;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!downloaded) throw lastErr;

    const expectedHash = getExpectedChecksum(archiveName);
    verifyChecksum(archivePath, expectedHash);

    if (isWindows) {
      extractZipWindows(archivePath, tmpDir);
    } else {
      // --no-same-owner / --no-same-permissions matter when postinstall
      // runs as root (e.g. system-wide npm install) — without them, a
      // hostile archive could set setuid/world-writable modes on the
      // extracted binary. The flags are accepted by both GNU tar (Linux)
      // and BSD tar (macOS). Modern tar already rejects ".." paths by
      // default; the post-extraction realpath check below is the second
      // line of defense against zip-slip via symlinks.
      execFileSync(
        "tar",
        [
          "-xzf", archivePath,
          "-C", tmpDir,
          "--no-same-owner",
          "--no-same-permissions",
        ],
        { stdio: "ignore" },
      );
    }

    const binaryName = NAME + (isWindows ? ".exe" : "");
    const extractedBinary = assertInsideDir(tmpDir, path.join(tmpDir, binaryName));
    fs.copyFileSync(extractedBinary, dest);
    fs.chmodSync(dest, 0o755);
    console.log(`${NAME} v${VERSION} installed successfully`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  if (!platform || !arch) {
    console.error(`Unsupported platform: ${process.platform}-${process.arch}`);
    process.exit(1);
  }

  // Skip when this script is running from a source-tree workspace install
  // rather than a real install of the published package. Real installs
  // place the package under .../node_modules/@everme/cli/scripts/install.js;
  // workspace dev installs leave __dirname pointing at the source path
  // (e.g. .../plugins/cli/scripts/) since npm symlinks the workspace into
  // node_modules but `__filename` is canonicalized via the symlink target.
  // Without this guard, `npm install` at the repo root fails when no GitHub
  // release exists yet for the in-development version.
  if (!__dirname.includes(`${path.sep}node_modules${path.sep}`)) {
    console.log(
      `[@everme/cli] Skipping binary download during workspace dev install. ` +
        `Set EVERME_CLI_FORCE_INSTALL=1 to override.`,
    );
    if (!process.env.EVERME_CLI_FORCE_INSTALL) process.exit(0);
  }

  // Explicit opt-out for sandboxed CI / Docker builds where network access
  // isn't available; users who set this know they need to download by hand.
  if (process.env.EVERME_CLI_SKIP_INSTALL) {
    console.log(`[@everme/cli] EVERME_CLI_SKIP_INSTALL=1, skipping download.`);
    process.exit(0);
  }

  // Under `npx`, npm runs postinstall but the user usually wants a quick
  // throwaway invocation — downloading the binary up-front blocks for ~5s
  // for nothing if their command doesn't actually run the binary
  // (e.g. `npx @everme/cli install` triggers the wizard, which doesn't
  // need the binary). Skip here and let run.js download lazily on first
  // real exec.
  const isNpxPostinstall = process.env.npm_command === "exec" && !process.env.EVERME_CLI_RUN;
  if (isNpxPostinstall) process.exit(0);

  try {
    install();
  } catch (err) {
    console.error(`Failed to install ${NAME}:`, err.message);
    console.error(
      `\nIf you are behind a firewall or in a restricted network, try one of:\n` +
        `  # 1. Use a proxy:\n` +
        `  export https_proxy=http://your-proxy:port\n` +
        `  npm install -g @everme/cli\n\n` +
        `  # 2. Point to a corporate npm mirror that proxies /-/binary/everme-cli/...:\n` +
        `  npm install -g @everme/cli --registry=https://your-corp-mirror/\n`,
    );
    process.exit(1);
  }
}

module.exports = {
  getExpectedChecksum,
  verifyChecksum,
  assertAllowedHost,
  assertInsideDir,
  resolveMirrorUrls,
};
