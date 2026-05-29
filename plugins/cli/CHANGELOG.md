# Changelog

All notable changes to `@everme/cli` are documented here. The version of this
package matches the `evercli` Go binary version it downloads.

## [Unreleased]

- Canonical binary downloads come from `EverMind-AI/EverMe` GitHub Releases
  using bare semver tags such as `v0.2.2`.
- The npm wrapper exposes the platform-native binary as `evercli`.
- SHA256 checksum verification against `sha256sums.txt` shipped in the package.
- Mirror chain: GitHub → npm_config_registry-derived binary mirror →
  registry.npmmirror.com.
- Lazy install fallback when `postinstall` is skipped (npx, restricted CI).
