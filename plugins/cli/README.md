# @everme/cli

npm-distributed installer for [EverMe CLI](https://github.com/EverMind-AI/EverMe). Detects your platform on install, downloads the matching pre-built binary from GitHub Releases, verifies its SHA-256 checksum, and exposes it as the `evercli` command.

```bash
npm install -g @everme/cli
evercli --help

# or, no install
npx @everme/cli --version
```

## What this package does

`@everme/cli` is a thin Node-side installer + runner; the actual CLI is a pre-compiled binary downloaded from `EverMind-AI/EverMe` GitHub Releases on first install. On `npm install`:

1. Detect platform / arch (darwin/linux/windows × amd64/arm64)
2. Download the matching archive from `https://github.com/EverMind-AI/EverMe/releases/download/v<version>/evercli_<os>_<arch>.{tar.gz|zip}`
3. Verify SHA-256 against the `sha256sums.txt` shipped inside this npm package
4. Extract and place the binary under the package's `bin/` directory
5. The `evercli` shim (`scripts/run.js`) execs that binary with your args

If `postinstall` was skipped (some `npx` flows, restricted CI), the installer runs lazily on first invocation.

### Mirrors / restricted networks

The installer tries download sources in this order:

1. `https://github.com/EverMind-AI/EverMe/releases/...` (canonical)
2. The npm registry's binary mirror path (`<registry>/-/binary/everme-cli/...`), if your `npm_config_registry` is non-default. `everme-cli` here is only the binary mirror namespace.
3. `https://registry.npmmirror.com/-/binary/everme-cli/...` (always tried as final fallback)

The first source to succeed wins. SHA-256 verification runs regardless of source.

### Self-hosted backend

Point the CLI at your own EverMe gateway:

```bash
export EVERCLI_API_BASE_URL=https://memory.acme-internal.com
evercli auth login
```

## License

Apache-2.0.
