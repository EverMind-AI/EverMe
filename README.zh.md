<div align="center" id="readme-top">

# EverMe CLI

<p align="center">
  <a href="https://x.com/evermind"><img src="https://img.shields.io/badge/EverMind-000000?labelColor=gray&style=for-the-badge&logo=x&logoColor=white" alt="X"></a>
  <a href="https://discord.gg/gYep5nQRZJ"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fdiscord.com%2Fapi%2Fv10%2Finvites%2FgYep5nQRZJ%3Fwith_counts%3Dtrue&query=%24.approximate_presence_count&suffix=%20online&label=Discord&color=404EED&labelColor=gray&style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://github.com/EverMind-AI/EverMe/actions"><img src="https://img.shields.io/github/actions/workflow/status/EverMind-AI/EverMe/ci.yml?branch=main&label=CI&style=for-the-badge" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue?style=for-the-badge" alt="License"></a>
</p>

**用于将 AI Agent 接入 [EverMe](https://evermind.ai/everme) 的开源 CLI、MCP Server、SDK 与 Agent 插件。**

> [!IMPORTANT]
> 本仓库仅包含开源的 EverMe 客户端工具链与 Agent 接入代码。EverMe 产品、Web 应用和托管后端是独立服务，不包含在本仓库中。

[产品主页](https://evermind.ai/everme) · [官网](https://evermind.ai) · [EverOS 记忆引擎](https://github.com/EverMind-AI/EverOS) · [文档](https://docs.evermind.ai/introduction) · [English](README.md)

</div>

<br>

<details open>
  <summary><kbd>目录</kbd></summary>

<br>

- [仓库概览](#仓库概览)
- [快速开始](#快速开始)
- [仓库结构](#仓库结构)
- [接入你的 Agent](#接入你的-agent)
- [架构](#架构)
- [本地开发](#本地开发)
- [公开契约](#公开契约)
- [安全](#安全)
- [贡献](#贡献)
- [License](#license)

<br>

</details>

## 仓库概览

本仓库提供把 Claude Code、Cursor、Codex、Kimi Code、Hermes、Raven、OpenClaw 等 AI Agent 接入 [EverMe](https://evermind.ai/everme) 记忆层所需的**客户端工具链**。EverMe 托管产品与 EverOS 记忆引擎分别独立：

| 层级 | 提供什么 | 在哪里 |
| :--- | :--- | :--- |
| **EverMe CLI + 插件**（本仓库）| 登录认证、插件安装、MCP server、Agent hooks | `EverMind-AI/EverMe`（Apache-2.0）|
| **EverOS** 记忆引擎 | 长期记忆操作系统 | [EverMind-AI/EverOS](https://github.com/EverMind-AI/EverOS)（已开源）|
| **EverMe 托管服务** | 后端、账号、计费 | [evermind.ai/everme](https://evermind.ai/everme) |

这套工具链既可以连接 EverMe 托管服务，也可以通过 `EVERME_API_BASE` 连接兼容的自托管 EverOS 端点。本仓库不包含 EverMe Web 应用、账号系统或计费服务。

<br>

## 快速开始

### 最快 —— 用一句话接入你的 Agent

把下面这句话粘贴给任意一个你本地已经在用的 AI Agent（Claude Code、Cursor、Codex、……）：

```text
Read https://everme.evermind.ai/SKILL.md and follow the instruction to install and configure EverMe.
```

Agent 会自动拉取 skill、安装 CLI、引导你登录，并为自己注册插件，无需手动编辑配置文件。

### 手动安装

```bash
# 1. 安装 CLI
npm install -g @everme/cli

# 2. 登录（浏览器走 Device Flow）
evercli auth login

# 3. 接入 Agent —— 装一个或多个：
evercli plugin install claude-code
evercli plugin install claude-desktop
evercli plugin install codex
evercli plugin install cursor
evercli plugin install devin
evercli plugin install dsh
evercli plugin install hermes
evercli plugin install kimicode
evercli plugin install opencode
evercli plugin install openclaw
evercli plugin install raven
evercli plugin install workbuddy

# 4. 自检
evercli doctor
```

Kimi Code 完成预配置后，还需要在 TUI 内运行 `/plugins install ~/.kimi-code/everme`；WorkBuddy 则需要在 MCP 管理界面信任新增的服务。

装好后打开你的 Agent，问它 "what do you remember about me?" —— 它会通过 MCP `mem://profile` 资源去召回你的记忆。

> 自托管 EverOS？在 `auth login` 之前设置 `EVERME_API_BASE=https://your-host`，CLI 就会去访问你自己的端点。

<br>

## 仓库结构

| 路径 | 包名 | 作用 |
| :--- | :--- | :--- |
| [`cli/`](cli/) | `evercli` | Go 写的 CLI，负责登录、插件安装、记忆导入、诊断 |
| [`plugins/agent-sdk/`](plugins/agent-sdk/) | `@everme/agent-sdk` | 共享 HTTP 客户端 + `evt_*`/`emk_*` token 脱敏 |
| [`plugins/memory-mcp/`](plugins/memory-mcp/) | `@everme/memory-mcp` | 暴露 `mem://profile` 与 `mem://search` 的 MCP server |
| [`plugins/claude-code/`](plugins/claude-code/) | `@everme/claude-code` | Claude Code 原生插件（hooks · commands · skills · MCP）|
| [`plugins/openclaw/`](plugins/openclaw/) | `@everme/openclaw` | OpenClaw ContextEngine 插件 |
| [`plugins/cli/`](plugins/cli/) | `@everme/cli` | 自动下载 `evercli` 平台二进制的 npm 封装 |
| [`plugins/codex/`](plugins/codex/) | `@everme/codex` | Codex 生命周期 hooks 与 marketplace 构建工具 |
| [`plugins/cursor/`](plugins/cursor/) | `@everme/cursor` | Cursor 原生生命周期 hooks |
| [`plugins/devin/`](plugins/devin/) | `@everme/devin` | Devin 原生生命周期 hooks |
| [`plugins/dsh/`](plugins/dsh/) | `@everme/dsh` | DeepSeek Harness 原生生命周期插件 |
| [`plugins/kimicode/`](plugins/kimicode/) | `@everme/kimicode` | Kimi Code 原生插件包 |
| [`plugins/everme/`](plugins/everme/) | Codex marketplace 插件 | 通过 MCP resources 给 Codex App / Codex CLI 提供召回 |

<br>

## 接入你的 Agent

每个 Agent 的配置入口不同。`evercli plugin install <agent>` 会执行对应平台的安装流程，并将承载凭据的文件权限设为 `0600`。

| Agent | 安装命令 | 写入的配置 |
| :--- | :--- | :--- |
| **Claude Code** | `evercli plugin install claude-code` | `~/.claude/everme.env` + 插件注册 |
| **Codex（App + CLI）** | `evercli plugin install codex` | `~/.codex/config.toml` MCP 条目 + marketplace 插件 |
| **Cursor** | `evercli plugin install cursor` | `~/.cursor/mcp.json` + 原生生命周期 hooks |
| **Claude Desktop** | `evercli plugin install claude-desktop` | Claude Desktop MCP 配置 |
| **Devin** | `evercli plugin install devin` | `~/.config/devin/mcp_config.json` + 原生生命周期 hooks |
| **DeepSeek Harness** | `evercli plugin install dsh` | 原生生命周期插件 + 托管 profile 补丁 |
| **Hermes** | `evercli plugin install hermes` | `$HERMES_HOME/config.yaml` + 内置 MemoryProvider |
| **Kimi Code** | `evercli plugin install kimicode` | 插件包预配置 + TUI 注册步骤 |
| **OpenCode** | `evercli plugin install opencode` | `~/.config/opencode/opencode.json` MCP 条目 |
| **OpenClaw** | `evercli plugin install openclaw` | OpenClaw 插件注册 |
| **Raven** | `evercli plugin install raven` | `~/.raven/config.json` + 内置 MemoryBackend |
| **WorkBuddy** | `evercli plugin install workbuddy` | `~/.workbuddy/mcp.json` + 首次连接信任步骤 |

所有 Agent 读写的记忆都落在**同一份记忆池**里，按你的账号隔离 —— 所以上下文跟着**你**走，而不是被锁在某个 App 里。

<br>

## 架构

```
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  Claude Code     │    │  Codex / Cursor  │    │  Hermes / etc.   │
└────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘
         │ MCP / Hooks           │ MCP                   │ MCP
         ▼                       ▼                       ▼
   ┌───────────────────────────────────────────────────────────┐
   │  @everme/* plugins  +  evercli  （本仓库）                 │
   │  - mem://profile  / mem://search    (MCP resources)        │
   │  - tools: mem_save_fact, mem_save_turn, mem_context, …     │
   │  - 凭据按 0600 落盘                                         │
   └────────────────────────┬──────────────────────────────────┘
                            │ HTTPS + Bearer evt_*
                            ▼
   ┌───────────────────────────────────────────────────────────┐
   │  EverMe 网关  →  EverOS 记忆引擎                            │
   │  (托管：api.everme.evermind.ai · 自托管：你的 URL)          │
   └───────────────────────────────────────────────────────────┘
```

记忆是**按用户全局**的（不按 workspace / 项目隔离）—— 同一个账号的多个 Agent、多台设备共读同一份记忆池，由语义搜索负责相关性排序。

<br>

## 本地开发

```bash
# CLI（Go）
cd cli
make build
make test          # go test -race ./...

# 插件 workspace（Node）
cd plugins
npm ci
npm test --workspaces --if-present
```

发布流程与打包规则见 [`cli/README.md`](cli/README.md) 和 [`Makefile`](Makefile)（`make dist` 生成干净的源码 tarball）。

<br>

## 公开契约

人和 AI Agent 都会调用这套工具链。CLI 的 stdout/stderr、结构化错误、MCP tools/resources、token 脱敏规则的稳定契约见 [`docs/contracts.md`](docs/contracts.md)。任何破坏这些契约的改动都按版本管理。

<br>

## 安全

不要在 issue 或 PR 中粘贴 API key、`emk_*`、`evt_*`、cookie 或私有日志。安全问题请按 [`SECURITY.md`](SECURITY.md) 提供的方式上报（`security@evermind.ai`）。

<br>

## EverMind 生态

EverMind 将记忆研究、可直接使用的产品与实际集成连接为一个开源生态。

<table>
<tr>
<th colspan="2">产品</th>
</tr>
<tr>
<td><strong><a href="https://github.com/EverMind-AI/EverOS">EverOS</a></strong></td>
<td>本地优先、Markdown 原生的 Agent 与用户长期记忆运行时。</td>
</tr>
<tr>
<td><strong><a href="https://github.com/EverMind-AI/Raven">Raven</a></strong></td>
<td>以记忆为核心的自进化 Agent Harness，具备主动性、上下文控制与 Skill 进化能力。</td>
</tr>
<tr>
<td><strong><a href="https://github.com/EverMind-AI/EverMe">EverMe（CLI）</a></strong></td>
<td>面向跨设备、跨 Agent 个人记忆的 CLI 与 Agent 插件套件。</td>
</tr>
<tr>
<th colspan="2">研究与评测</th>
</tr>
<tr>
<td><strong><a href="https://github.com/EverMind-AI/SkillCorpus">SkillCorpus</a></strong></td>
<td>将分散的 Agent Skill 整理为可检索语料库，并提供检索与评测工具。</td>
</tr>
<tr>
<td><strong><a href="https://github.com/EverMind-AI/EverAlgo">EverAlgo</a></strong></td>
<td>为 EverOS 提供无状态的提取、排序、解析与记忆算法。</td>
</tr>
<tr>
<td><strong><a href="https://github.com/EverMind-AI/HyperMem">HyperMem</a></strong></td>
<td>基于超图的分层记忆架构，用于由粗到细的长期对话检索。</td>
</tr>
<tr>
<td><strong><a href="https://github.com/EverMind-AI/MSA">MSA</a></strong></td>
<td>面向可扩展潜在记忆与一亿 Token 上下文的 Memory Sparse Attention。</td>
</tr>
<tr>
<td><strong><a href="https://github.com/EverMind-AI/EverMemBench">EverMemBench</a></strong></td>
<td>从事实召回、应用推理和个性化泛化三个层面评测记忆系统。</td>
</tr>
<tr>
<td><strong><a href="https://github.com/EverMind-AI/EvoAgentBench">EvoAgentBench</a></strong></td>
<td>纵向评测 Agent 自进化、迁移效率、错误规避和 Skill 使用能力。</td>
</tr>
<tr>
<th colspan="2"><a href="https://github.com/EverMind-AI/plugins">插件与集成</a></th>
</tr>
<tr>
<td><strong><a href="https://docs.openclaw.ai">OpenClaw</a></strong></td>
<td><a href="https://github.com/EverMind-AI/plugins/tree/main/openclaw">OpenClaw 插件</a>，自动管理召回、写入与会话记忆生命周期。</td>
</tr>
<tr>
<td><strong><a href="https://github.com/NousResearch/hermes-agent">Hermes Agent</a></strong></td>
<td><a href="https://github.com/EverMind-AI/plugins/tree/main/hermes">Hermes 插件</a>，为 Hermes 会话提供持久记忆。</td>
</tr>
<tr>
<td><strong><a href="https://github.com/deepseek-ai/DeepSeek-Harness">DeepSeek Harness</a></strong></td>
<td><a href="https://github.com/EverMind-AI/plugins/tree/main/dsh">DSH 插件</a>，让 DeepSeek Harness Agent 使用长期记忆。</td>
</tr>
<tr>
<td><strong><a href="https://dify.ai">Dify</a></strong></td>
<td><a href="https://github.com/EverMind-AI/plugins/tree/main/dify">本地版</a>与<a href="https://github.com/EverMind-AI/plugins/tree/main/dify_cloud">云端版</a>工具，在工作流和 Agent 中显式搜索与写入记忆。</td>
</tr>
</table>

这些项目共同构成 EverMind 从研究到运行时的完整链路：将方法与评测转化为
可复用的记忆基础设施、产品和 Agent 集成。

## 贡献

见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。欢迎 bug 反馈、新增 Agent 的插件支持、以及更多记忆导入器的实现。

<br>

## License

[Apache-2.0](LICENSE)。该许可证仅适用于本仓库中的源代码，不适用于 EverMe 托管产品或服务。© 2026 EverMind AI。

<div align="right">

[![](https://img.shields.io/badge/-Back_to_top-gray?style=flat-square)](#readme-top)

</div>
