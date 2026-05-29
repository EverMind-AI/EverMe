# Security Policy

## Reporting A Vulnerability

Please do not open a public issue for security vulnerabilities or leaked
credentials.

Report issues privately to:

```text
security@evermind.ai
```

Include:

- affected package or path,
- reproduction steps,
- impact,
- whether any credential may have been exposed.

## Sensitive Data

Do not paste these values into public issues, pull requests, logs, screenshots,
or examples:

- EverMe API keys such as `emk_*`,
- EverMe agent tokens such as `evt_*`,
- cookies, OAuth tokens, or cloud credentials,
- private workspace paths that expose usernames or tenant data,
- production diagnostics or private logs.

The CLI and plugins are expected to redact full `emk_*` and `evt_*` values
before writing logs, model context, or user-facing errors.
