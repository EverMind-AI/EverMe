# Changelog

All notable changes to `@everme/cli` are documented here. The version of this
package matches the `evercli` Go binary version it downloads.

## [0.1.0-beta.3] - 2026-05-12

### Changed

- `evercli import run <platform>` now sends `originPlatform: <platform>` in
  the source-create request. Cold-start imports attribute correctly to the
  target AI agent platform (claude-code, openclaw, …) in the EverMe UI
  instead of appearing under "EverCli". Pairs with server-side
  `source.origin_platform` column (migration 000005) + BFF view-layer
  attribution rewrite. Backward compatible with older servers — they
  silently ignore the extra field. Older beta.1/beta.2 CLIs continue to
  work but their cold-start imports surface as the EverCli placeholder
  until the user upgrades.

## [0.1.0-beta.2] - 2026-05-12

### Fixed

- `evercli plugin install claude-code` now resolves the Claude Code plugin
  source via `npm install -g @everme/claude-code` (a globally-installed npm
  package) instead of a stale GitHub URL fallback that was never reachable in
  production. The hardcoded `https://github.com/EverMind-AI/everme.git`
  fallback (which 404'd because the org was wrong, and would have 404'd at the
  next step anyway because the mirror repo has no plugin source) is removed.
- The mono-repo `devPluginSourcePath()` auto-fallback is also removed so dev
  and prod take the same code path. Developers wanting to test local plugin
  changes should set `EVERCLI_CLAUDE_PLUGIN_SOURCE=/path/to/plugins/claude-code/`
  explicitly.
- The error hint surfaced when `claude plugin marketplace add` fails now
  explicitly rules out `gh auth login` as a remediation — earlier AI agents
  inferred it was a GitHub auth issue and went hunting for credentials.

### Changed (BREAKING)

- **CLI command renamed from `everme` to `evercli`.** The Go binary has always
  self-identified as `evercli` (in `--version` output, `EVERCLI_*` env vars,
  log tags, HTTP User-Agent, JSON `resumeCommand` field, and the `platform`
  field sent to the backend); only the npm bin alias was `everme`, creating a
  confusing split. The npm bin is now `evercli` to match.
  - **Migration**: `npm uninstall -g @everme/cli && npm install -g @everme/cli@beta`,
    then replace `everme` with `evercli` in any shell scripts or aliases.

## [0.1.0-beta.1] - 2026-05-11

- Initial release: npm wrapper that downloads platform-matched `evercli` binary
  from GitHub Releases and exposes it (at the time, as the `everme` command;
  renamed to `evercli` in 0.1.0-beta.2).
- SHA256 checksum verification against `sha256sums.txt` shipped in the package.
- Mirror chain: GitHub → npm_config_registry-derived → registry.npmmirror.com.
- Lazy install fallback when `postinstall` is skipped (npx, restricted CI).
