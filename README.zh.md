# EverMe

EverMe 是面向 AI Agent 的开源 CLI 与插件层，用于把 Codex、Claude Code、
OpenClaw、Cursor 等工具接入持久记忆。本仓库只包含本地工具和 Agent
集成代码，让 Agent 宿主可以读取和写入 EverMe 记忆。

## 仓库内容

```text
cli/       evercli 命令行工具，Go 实现
plugins/   Agent 插件、MCP server、npm wrapper 和共享 SDK
```

## 快速开始

```bash
npm install -g @everme/cli
evercli auth login
evercli plugin install codex
evercli doctor
```

## 本地开发

```bash
cd cli
make build
make test
```

```bash
cd plugins
npm ci
npm test --workspaces --if-present
```

## 公开契约

EverMe 的 CLI 输出、结构化错误、MCP tools/resources 和 token 脱敏规则会被
AI Agent 直接读取。公开稳定契约见 [docs/contracts.md](docs/contracts.md)。

## 安全

不要在 issue 或 PR 中粘贴 API key、`emk_*`、`evt_*`、cookie 或私有日志。
安全问题请按 [SECURITY.md](SECURITY.md) 中的方式私下报告。

## License

Apache-2.0.
