<div align="center">

# Synax

<img width="898" height="80" alt="Synax" src="https://github.com/user-attachments/assets/ba60d60b-ee63-4409-b158-33754f4efe80" />

在本地用 Agent 写代码、整理项目文档。

[English](./README.md) | 简体中文

</div>

Synax 把 Agent 对话、源码、文件差异和终端放在同一个应用里。导入本地项目后，可以直接开始任务，也可以先从源码生成 Wiki，了解项目结构，再沿着文档中的引用查看代码。

项目目前处于 alpha 阶段。Wiki 和规划功能仍在实验中，默认关闭；外部 Agent 的接入还在完善，版本之间的数据格式也可能变化。

## 主要功能

### 写代码、运行和检查改动

内置 Agent 可以搜索仓库、读写文件、应用补丁和运行命令。对话旁就能查看源码、文件差异、终端和 Git worktree。任务执行时会逐步展示工具调用和命令输出，需要授权的操作会发起权限请求。

### 自选模型，也能接入外部 Agent

可以给 Synax 内置 Agent 配置自己的模型 API，也可以接入 Codex、Claude Code 等外部 Agent。自定义端点支持 Chat Completions、Responses 和 Anthropic Messages。在模型支持的情况下，可以直接在输入框旁选择模型和推理强度。外部 Agent 的接入仍在完善中。

### 把任务交给子 Agent

内置 Agent 可以把代码探索、审查等工作交给拥有独立上下文的子 Agent。子会话单独记录执行过程，再把结果返回主会话，避免一次仓库搜索把主对话塞满。还可以为专门的子任务指定工具和允许修改的文件范围。

### 接入 MCP 和 Skills

通过 MCP 连接外部工具，通过 Skills 加载项目需要的操作说明。项目设置中提供本地发现、已接入 MCP 和 Skill 市场，可以按项目启用工具与技能，省去每次对话重复配置。

### 搜索资料，也能操作浏览器

Agent 可以搜索文档并返回来源链接。搜索支持模型服务商的原生搜索、DuckDuckGo、Brave、Tavily 和自定义 JSON API，配置的渠道不可用时会尝试备用渠道。

浏览器工具支持打开网页、点击、填写表单、截图，以及检查控制台消息和网络请求。修改 Web 项目后，可以让 Agent 打开页面检查实际效果。浏览器操作需要本机安装受支持的浏览器。

### 图片、音频、视频和文件

模型支持时，可以把截图、文档、音频或视频直接附在对话里。内置 Agent 还提供图片生成与编辑、语音合成、音频转写和视频生成工具。生成的媒体可以预览、下载，也可以作为后续请求的素材。输入格式和生成选项取决于配置的服务商与模型。

### 保留历史，继续长任务

会话和执行历史保存在本地。对话变长后，运行服务可以压缩较早的上下文，保留近期步骤以及筛选出的需求、决策和执行结果。界面会显示上下文用量；服务商返回缓存统计时，也能看到缓存命中情况。

### 从源码生成 Wiki，代码变了再更新

Synax 用 tree-sitter 分析源码文件和符号，再生成带代码引用的项目文档。可以按目录阅读、搜索内容、查看图表，也可以导出 Markdown。代码发生变化后，刷新检查会找出受影响的文档，生成草稿供审阅。

Wiki 还提供实验性的规划视图，用于拆分任务和查看依赖关系。Wiki 和规划默认关闭，需要在设置中开启 **Wiki（实验性功能）**。

### 浏览器、桌面和命令行

Web、Electron 桌面端和 CLI 共用本地 API 与 Agent 运行服务。桌面构建覆盖 macOS、Windows 和 Linux，Windows 还可以使用 WSL2 中的项目。CLI 支持交互对话、单次任务，以及供脚本使用的 JSONL 输出。

项目记录、配置和对话历史保存在本地。使用远程模型时，提示词和上下文中的代码会发送给所选模型服务商。

## 从源码运行

需要 Node.js **22**（`>=22 <23`）、npm 10 或更新版本，以及 Git。原生依赖还需要 Python 3 和 C/C++ 构建工具：

| 系统    | 构建工具                                                        |
| ------- | --------------------------------------------------------------- |
| macOS   | Xcode Command Line Tools（`xcode-select --install`）            |
| Windows | Visual Studio **2022** Build Tools，勾选「使用 C++ 的桌面开发」 |
| Linux   | GCC、G++ 和 Make；Debian/Ubuntu 可安装 `build-essential`        |

```bash
git clone https://github.com/coldmint9/Synax.git
cd Synax
npm ci --include=dev
npm run dev
```

打开 [localhost:5173](http://localhost:5173)，API 默认使用 `3210` 端口。

1. 在设置中添加模型服务商，填写 API Key 并选择模型。
2. 导入本地项目目录。
3. 使用 Synax 内置 Agent 开始对话。

如果要生成文档，先在设置中开启 **Wiki（实验性功能）**，配置 Wiki 使用的模型，再进入项目的 Wiki 页面。

使用桌面应用时，将 `npm run dev` 换成：

```bash
npm run dev:desktop
```

这条命令会一起启动 Electron、API 和 Web 开发服务。打包后的桌面应用自带运行时，无需另外安装 Node.js。

## 模型与 Agent

设置中提供 OpenAI、Anthropic、DeepSeek、OpenRouter 和 xAI 的配置预设。其他服务可以通过自定义端点接入，支持以下 API 格式：

- OpenAI Chat Completions
- OpenAI Responses
- Anthropic Messages

内置 Agent 可以选择服务商和模型，Wiki 使用的模型单独配置。具体可用功能取决于模型和端点。

Synax 也提供 Codex、Claude Code 和 ACP 等外部 Agent 的接入，需要先在本机安装并配置对应工具。这部分仍在开发中。

## Windows 与 WSL2

Windows 桌面版可以导入 WSL2 发行版中的项目。在项目导入窗口选择 **WSL2**，选择发行版，再填写 `/home/user/project` 这样的 Linux 路径。Shell 命令、Git 和 worktree 操作会在该发行版中执行。

同一个工作区的目录必须来自同一环境：Windows，或同一个 WSL2 发行版。WSL2 项目目前只支持 Synax 内置 Agent。

## 命令行

在仓库根目录构建 CLI：

```bash
npm run build
node server-dist/cli.cjs --help
node server-dist/cli.cjs backends
node server-dist/cli.cjs exec --work-dir /path/to/project "解释这个项目的启动过程"
```

CLI 会连接本地运行服务，尚未启动时会自动启动。默认使用当前目录，也可以通过 `--work-dir` 指定项目；项目未注册时会自动注册。不带子命令运行会进入交互对话。

`--json` 输出最终结果，`--jsonl` 输出流式事件。`rpc` 命令从标准输入接收 JSONL，并通过标准输出返回响应和事件。

连接已有服务时，设置 `SYNAX_API` 或传入 `--url`。认证信息可以通过 `SYNAX_RUNTIME_TOKEN`、`--token` 或 `--token-file` 提供；本地运行服务的令牌保存在 `${DATA_ROOT}/runtime-access-token`。

## 本地数据与配置

数据默认保存在 `~/.synax`，Windows 下为 `%USERPROFILE%\.synax`。可以通过 `DATA_ROOT` 更换目录。

从源码运行时，API 会读取 `.env`。模型连接在应用内配置，使用默认设置不需要创建 `.env` 文件。

| 变量                    | 默认值     | 用途                   |
| ----------------------- | ---------- | ---------------------- |
| `DATA_ROOT`             | `~/.synax` | 数据库、配置和日志     |
| `PORT`                  | `3210`     | API 端口               |
| `WEB_PORT`              | `5173`     | Web 开发服务端口       |
| `WEB_HOST`              | `0.0.0.0`  | Web 开发服务监听地址   |
| `LOG_LEVEL`             | `info`     | API 日志级别           |
| `CONFIG_ENCRYPTION_KEY` | 内置备用值 | 加密保存的模型服务凭据 |

`WEB_PORT` 和 `WEB_HOST` 需要在启动开发脚本的终端中设置。保存模型凭据前，请设置自己的 `CONFIG_ENCRYPTION_KEY`，迁移数据时保留同一个值；更换后将无法解密已有凭据。也可以使用备用变量 `Synax_CONFIG_SECRET`。

## 构建桌面应用

```bash
npm run make:desktop
```

需要在目标**操作系统和 CPU 架构**上安装依赖并构建，libSQL、tree-sitter 和 node-pty 都包含原生二进制。

| 目标                | CI runner        | 产物                   |
| ------------------- | ---------------- | ---------------------- |
| macOS Apple Silicon | `macos-15`       | DMG、ZIP               |
| macOS Intel         | `macos-15-intel` | DMG、ZIP               |
| Windows x64         | `windows-2022`   | Squirrel 安装程序、ZIP |
| Linux x64           | `ubuntu-latest`  | ZIP                    |

产物保存在 `out/make/`。如果只需要应用目录，可以使用 `npm run build:desktop`。目前没有配置签名和公证，打开应用时可能出现系统提示。

打包后的 macOS 和 Windows 应用会从 GitHub Releases 检查更新，也可以通过**帮助 → 软件更新…**手动检查。兼容的界面更新在重启后生效；加载失败时可以回退到先前的界面。Linux 暂不支持此更新功能。

桌面版本使用 `v*` 标签，纯界面版本使用 `ui-v*` 标签。构建与发布步骤见[桌面工作流](./.github/workflows/build-desktop.yml)和[界面工作流](./.github/workflows/build-ui-release.yml)。界面更新必须对应已发布的桌面版本，不能包含后端或 Electron 代码变更。更新下载使用 HTTPS 和哈希校验，没有独立的内容签名，可信来源取决于仓库的发布权限。

每次向 `main` 推送都会构建上述四个平台。全部构建和检查成功后，工作流更新固定 `preview` 标签下的[最新预览版](https://github.com/coldmint9/Synax/releases/tag/preview)，发布说明包含应用基础版本、提交和 Actions 构建记录。预览版供手动下载安装，正式版自动更新不会选择预发布版本。旧构建不会覆盖 main 更新后的预览版；替换下载文件期间，预览发布暂时保持为草稿。发布失败时，可以在 `main` 上手动运行 **Build Desktop** 重试。

## 开发

后端使用 Hono、libSQL 和 Drizzle，前端使用 React、Vite、HeroUI 和 Zustand。桌面端使用 Electron，源码解析使用 tree-sitter。

```text
api/        API 路由、数据库、代码分析、Wiki 和 Agent 运行服务
web/        React 前端
electron/   桌面应用和更新器
cli/        终端客户端
scripts/    开发、构建、发布和冒烟测试脚本
```

| 命令                         | 用途                                   |
| ---------------------------- | -------------------------------------- |
| `npm run dev:api`            | 启动 API                               |
| `npm run dev:web`            | 启动 Web 开发服务                      |
| `npm run build`              | 构建 API 和 CLI，输出到 `server-dist/` |
| `npm run start`              | 运行构建后的 API                       |
| `npm run web:build`          | 构建前端，输出到 `web/dist/`           |
| `npm run typecheck`          | 检查后端 TypeScript                    |
| `npm run typecheck:cli`      | 检查 CLI TypeScript                    |
| `npm run lint`               | 检查 API 代码规范                      |
| `npm test`                   | 运行后端、CLI 和桌面端单元测试         |
| `npm run --prefix web test`  | 运行前端测试                           |
| `npm run test:desktop:smoke` | 对打包后的应用运行冒烟测试             |

报告问题时，请提供复现步骤、系统和 Node.js 版本，以及相关日志或截图。提交 PR 时说明改了什么、如何验证；涉及运行逻辑、持久化、API 契约或 Wiki 生成的改动，请补充测试。较大的改动可以先开 Issue 讨论。

## 许可

[MIT](./LICENSE)
