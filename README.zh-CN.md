<div align="center">

# Synax

本地优先的 AI 代码智能工作台，用于生成代码库 Wiki、运行 Agent 会话，并沉淀实现上下文。

[English](./README.md) | 简体中文

![Status](https://img.shields.io/badge/status-alpha-f59e0b?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?style=flat-square&logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-19-61dafb?style=flat-square&logo=react&logoColor=black)
![Electron](https://img.shields.io/badge/Electron-42-47848f?style=flat-square&logo=electron&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-24%2B-339933?style=flat-square&logo=node.js&logoColor=white)

</div>

## 项目概览

Synax 让 AI 辅助研发始终贴近真实代码库。你可以导入本地仓库，生成可追溯到源码的设计 Wiki，运行有权限边界的 Agent 会话，并把项目记忆、决策、运行证据和实现上下文持续沉淀下来。

项目采用 TypeScript monorepo 架构，包含 Hono API、React Web 客户端、SQLite 本地持久化、基于 tree-sitter 的代码分析、Profile 驱动的 Agent Runtime，以及 Electron 桌面壳。

## 核心能力

- Codebase Design Wiki：从源码生成分层文档，把 Wiki 内容绑定到文件和符号，支持 Markdown 导出，并在代码变化后进行增量刷新。
- Agent Runtime：内置 planner、executor、reviewer、explorer 和 Wiki 专用 Profile，支持流式事件、权限闸门、暂停、恢复、取消和会话历史。
- Context Memory：把项目上下文、对话、运行证据、token 预警、压缩状态和可搜索记忆保存在本地 SQLite。
- Code Intelligence：索引 TypeScript、TSX、JavaScript、JSX、Python、Java、C、C++、C#、Go、Rust、PHP、Ruby、Kotlin、Swift、SQL 和 shell 文件。
- Provider Flexibility：支持配置 OpenAI、Anthropic、DeepSeek、OpenRouter、xAI、自定义 OpenAI-compatible API、OpenCode 和 Cursor 等 ACP Provider，以及基于 AI SDK 的模型运行时。
- Web 与桌面端：既可以作为 Vite Web 应用独立运行，也可以打包为带 API sidecar 的 Electron 桌面应用。

## 架构

```mermaid
flowchart LR
  Repo[本地代码库] --> Analyzer[tree-sitter 分析器]
  Analyzer --> API[Hono API]
  API --> DB[(SQLite + JSON 配置)]
  API --> Runtime[Agent Runtime]
  Runtime --> Providers[LLM Provider / ACP]
  Web[React Web App] --> API
  Desktop[Electron Shell] --> Web
  Desktop --> API
```

## 快速开始

### 环境要求

- Node.js 24 或更高版本。
- npm 10 或更高版本。
- Git。
- tree-sitter 依赖需要原生构建工具。macOS 请安装 Xcode Command Line Tools。
- 如需生成 Wiki 或运行 Agent，需要至少配置一个 LLM Provider key，或准备一个可用的 ACP Runtime。

### 安装

```bash
git clone https://github.com/weiweizwc98/Synax.git
cd Synax
npm install
```

### 启动 Web 应用

```bash
npm run dev
```

API 默认启动在 `http://localhost:3210`，Web 应用默认启动在 `http://localhost:5173`。

首次使用建议流程：

1. 打开 `http://localhost:5173`。
2. 进入 Settings，配置 LLM 或 ACP Provider。
3. 导入一个本地项目目录。
4. 打开 Wiki 页面，生成第一份 Codebase Design Wiki。

### 启动桌面应用

```bash
npm run dev:desktop
```

开发模式下，Electron 会连接本地 Web 和 API 服务。打包后，Electron 会启动内置的 API sidecar。

## 配置

Synax 会通过 `dotenv/config` 自动读取 `.env`，但项目不要求必须提供模板文件。只有在需要覆盖默认值时才需要手动创建 `.env`。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3210` | API 服务端口。 |
| `WEB_PORT` | `5173` | Vite 开发服务端口。 |
| `WEB_HOST` | `0.0.0.0` | 开发脚本使用的 Vite host。 |
| `DATA_ROOT` | `.data` | 本地数据目录，用于 SQLite、项目元数据、配置、日志和模型目录缓存。 |
| `LOG_LEVEL` | `info` | API 日志级别。 |
| `CONFIG_ENCRYPTION_KEY` | 未设置 | 用于加密本地保存的 Provider key。 |
| `Synax_CONFIG_SECRET` | 未设置 | 配置加密的备用密钥。 |
| `CONTEXT_SESSION_TTL_HOURS` | `72` | Context session 过期时间。 |
| `CONTEXT_TOKEN_WARNING_THRESHOLD` | `32000` | Context session 的 token 预警阈值。 |
| `CONTEXT_MEMORY_MAX_PER_PROJECT` | `500` | 单项目最大记忆条目数。 |

运行数据默认保存在本地，并且不会提交到 Git。如果你希望长期保存或跨环境迁移 Provider 凭据，请在写入凭据前设置稳定的 `CONFIG_ENCRYPTION_KEY` 或 `Synax_CONFIG_SECRET`。

## 常用脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 同时启动 API 和 Web 开发服务。 |
| `npm run dev:api` | 仅启动 Hono API 服务。 |
| `npm run dev:web` | 仅启动 Vite Web 应用。 |
| `npm run dev:desktop` | 启动 API、Web、Electron 编译监听和 Electron。 |
| `npm run build` | 将 API 服务打包到 `server-dist/`。 |
| `npm run start` | 运行已打包的 API 服务。 |
| `npm run web:build` | 将 Web 应用构建到 `web/dist/`。 |
| `npm run typecheck` | 运行根项目 TypeScript 检查。 |
| `npm run lint` | 检查 API 代码。 |
| `npm run test` | 运行 Vitest 测试。 |
| `npm run build:desktop` | 打包本地 Electron 应用。 |
| `npm run make:desktop` | 使用 Electron Forge 生成可分发产物。 |

## 项目结构

```text
api/        Hono 路由、SQLite schema、迁移、分析器、Wiki、Context 和 Agent Runtime
web/        React 19、Vite、HeroUI、Zustand、Wiki UI、Sessions UI、设置和 API Client
electron/   桌面壳、preload bridge、菜单集成、窗口状态和 API sidecar 启动器
scripts/    API、Web、桌面端和组合开发流程的启动脚本
docs/       Codebase Design Wiki 的设计说明和技术计划
```

## API 模块

API 统一挂载在 `/api` 下，并按领域拆分：

- `/api/projects`：项目元数据和本地项目导入。
- `/api/wiki`：snapshot、document、block、refresh draft、patch、export 和 design mapping。
- `/api/agent-runtime`：profile、skill、context、session、流式 turn、permission 和 runtime event。
- `/api/config` 与 `/api/llm`：Provider 配置和模型发现。
- `/api/context`：memory、coordinates、session 和上下文信号。
- `/api/acp`：Agent Client Protocol 发现和 Provider 集成。
- `/api/notifications`、`/api/logs`、`/api/health`：运行状态与运维辅助接口。

## 开发流程

1. 保持改动聚焦，方便 review。
2. 如果修改 Runtime 行为、持久化、路由契约或 Wiki 生成逻辑，请补充或更新测试。
3. 提交 PR 前运行相关检查：

```bash
npm run typecheck
npm run test
npm run lint
```

## 打包

构建所有运行时资源并打包桌面应用：

```bash
npm run build:desktop
```

使用 Electron Forge 生成可分发产物：

```bash
npm run make:desktop
```

打包产物会把 `server-dist`、`web/dist` 和数据库迁移文件作为 Electron resources 一起带上。

## 贡献

贡献内容应包含清晰的问题描述、聚焦的实现以及验证说明。对于较大的改动，建议先提交 issue 或设计讨论，提前确认 Runtime、持久化和 UI 影响。

## 许可

当前仓库尚未包含 license 文件。在作为开源项目发布或分发前，请先补充明确的开源许可证。
