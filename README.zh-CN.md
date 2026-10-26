<div align="center">

# Synax

在本地用 Agent 写代码、整理项目文档。

[English](./README.md) | 简体中文

</div>

Synax 把 Agent 对话、源码、文件差异和终端放在同一个应用里。导入本地项目后，可以直接开始任务，查看源码、审查改动，并在终端中验证结果。

项目目前处于 alpha 阶段。

会话统一使用原生 Synax 引擎。ACP 和外部 Agent CLI/SDK 执行适配器已移除；旧会话保留历史查看和归档，新任务请新建 Synax 会话。模型 API、MCP 和电脑操作工具由原生引擎继续调用。

当前执行目录检测到 `pom.xml`，或在同一 Git 仓库内向上找到 Maven 项目时，系统提示词自动加入构建优化指导：优先 Maven Wrapper、按模块增量验证、避免无必要的 `clean`，仅在插件支持时启用并行构建，并明确报告跳过的测试。未检测到 Maven 时不注入。

新增 `file.generate`：Agent 可用 Python 模板、循环和文本转换生成多个文件，适合脚手架、批量改写及较长或转义敏感的内容。小改动继续使用 `file.patch`，短文件全文使用 `file.write`。脚本通过 `synax.write/delete/move` 暂存操作，提交前统一检查权限、路径、文件新鲜度和写入范围；提交失败会回滚，恢复不完整时报告残留路径。删除和移动仍要求 `file.delete` 能力。

桌面安装包捆绑固定版本 Python，无需用户另装解释器，安装包预计增加约 30–45 MB（以各平台构建结果为准）。开发环境可使用 `PATH` 中的 `python3`，或用 `SYNAX_PYTHON_RUNTIME` 指定解释器；缺少运行时时工具不显示。脚本限制为 120 个文件、合计 64 MiB、单文件 8 MiB、UTF-8 文本；普通 `open()`/`pathlib` 只能读取工作区，不能联网或启动子进程。审批显示脚本源码，最终文件清单在执行后返回。Python audit hook 是防误操作护栏，不是抵御恶意代码的硬化沙箱。

## 快速开始

### 1. 环境要求

安装 [Node.js](https://nodejs.org) **22**（`>=22 <23`）、npm 10 或更新版本，以及 Git。原生依赖还需要 Python 3 和 C/C++ 构建工具：

| 系统    | 构建工具                                                        |
| ------- | --------------------------------------------------------------- |
| macOS   | Xcode Command Line Tools（`xcode-select --install`）            |
| Windows | Visual Studio **2022** Build Tools，勾选「使用 C++ 的桌面开发」 |
| Linux   | GCC、G++ 和 Make；Debian/Ubuntu 可安装 `build-essential`        |

### 2. 安装依赖

```bash
git clone https://github.com/coldmint9/Synax.git
cd Synax
npm install
```

### 3. 启动应用

下面两种方式可按需启动。开发命令默认使用独立 Profile，桌面生产版、Web 开发版和桌面开发版不会共用运行时数据。

#### Web 端（浏览器）

一条命令同时启动 API 与前端：

```bash
npm run dev:all
```

`npm run dev` 是同一脚本的别名。Web 开发 Profile 使用 `3211` 端口运行 API、使用 `5174` 端口运行 Web 开发服务，并将数据放在 `~/.synax/web-dev`，然后打开 [localhost:5174](http://localhost:5174) 即可使用。

#### 生产构建

构建运行服务和前端：

```bash
npm run build
npm run client:build
```

构建产物分别位于 `server-dist/` 和 `client/dist/`。浏览器使用流程通过 `npm run dev:all` 启动；打包桌面应用使用 `npm run build:desktop`。

#### 本地存储

Synax 2.0 使用 Rust Runtime Sidecar 的 RocksDB 保存会话运行态、历史、上下文记忆、技能与扩展开关、工具授权、媒体任务、终端和进程租约。配置、项目注册和日志使用 JSON/文件存储；运行目录由 `DATA_ROOT` 指定，默认是 `~/.synax`。项目不再创建或读取 SQLite 数据库。

#### 桌面端（Electron）

```bash
npm run dev:desktop
```

先编译 Electron 的 TypeScript 源码，再启动 API 与 Web 服务，等两者就绪后通过 `electronmon` 启动 Electron 并开启热重载。桌面窗口会自动打开，无需浏览器。

桌面生产版继续使用 `~/.synax`，Web 开发 Profile 使用 `~/.synax/web-dev`，两者不会共享数据库、会话、运行时 Token 或项目索引。如果还需要同时运行桌面开发版，`npm run dev:desktop` 会自动使用 `~/.synax/desktop-dev`，继续使用 `5173` 作为 Vite 端口，Sidecar API 则由操作系统分配临时端口。也可以通过 `DATA_ROOT`、`PORT` 和 `WEB_PORT` 显式覆盖当前 Profile 的默认值。

如果需要打包出可安装的桌面应用，而不是以开发模式运行：

```bash
npm run make:desktop
```

产物保存在 `out/make/`。需要在目标**操作系统和 CPU 架构**上构建，libSQL 和 node-pty 包含原生二进制。打包后的应用自带运行时，使用者无需另外安装 Node.js。

桌面整包更新使用 `electron-updater` 获取清单并校验下载：macOS 使用应用 ZIP，Windows 使用以 `-NSIS.exe` 结尾的安装包。Developer ID 签名的 macOS 应用使用原生框架安装；ad-hoc、未签名和自签名应用使用 Synax 的应用替换辅助程序，校验压缩包、版本和架构后暂存新应用，等待退出，再替换并重启，旧应用保留至新版本报告健康。自签名应用更新必须保持相同签名身份。下载和重启仍需用户确认。仅使用原生更新器的旧 macOS 版本可能需要手动安装一次才能迁移到此流程。`make:desktop` 在 Windows 上会同时生成 NSIS 产物；旧 Windows Squirrel 安装和便携版需要手动安装一次 NSIS 版。迁移时保留 `~/.synax` 和用户配置。旧 Squirrel 包、DMG 和更新清单继续发布，兼容界面更新保留独立流程。

未设置 `SYNAX_MAC_SIGN_IDENTITY` 时，macOS 构建默认使用免费的 ad-hoc 签名，稳定 Tag 也适用；兼容更新流程不需要证书或 Apple 付费账号。ad-hoc 签名验证完整性，但不证明发布者身份：发布来源的真实性依赖 HTTPS 发布源，首次安装仍需通过 Gatekeeper 的用户许可，Synax 不关闭系统安全设置。启用 Developer ID 签名时，配置 `SYNAX_MAC_SIGN_IDENTITY` 和已导入的证书；CI 通过 `SYNAX_MAC_CERTIFICATE`（base64 P12）与 `SYNAX_MAC_CERTIFICATE_PASSWORD` 导入，公证另外使用 `SYNAX_APPLE_ID`、`SYNAX_APPLE_APP_PASSWORD` 和 `SYNAX_APPLE_TEAM_ID`。Windows 本地构建在没有 `CSC_LINK` 与 `CSC_KEY_PASSWORD` 时，会自动生成有效期十年的自签名代码签名证书，并在 Forge 与 NSIS 构建中复用同一证书。稳定版 CI 必须把同一个 PFX 的 base64 内容、密码和发布者分别保存到 `SYNAX_WINDOWS_CSC_LINK`、`SYNAX_WINDOWS_CSC_KEY_PASSWORD` 和 `SYNAX_WINDOWS_PUBLISHER`；NSIS 安装器会在应用启动前把公证书加入当前用户的 Trusted Publishers。这样 electron-updater 可以持续校验安装包；自签名证书不会获得 Windows SmartScreen 或公共信任。若有受信任的商业证书，可提供 `SYNAX_WINDOWS_PUBLISHER`、`CSC_LINK` 与 `CSC_KEY_PASSWORD` 覆盖自签流程。更新清单签名通过 `SYNAX_UPDATE_SIGNING_KEY` 与 `SYNAX_UPDATE_PUBLIC_KEY` 单独配置。更新清单按平台和架构隔离，只有 macOS x64/arm64 与 Windows x64 产物齐全时才推进 latest；旧完整版本重跑不会再次置顶。

Electron 桌面版通过应用托管的 Cua Driver 提供电脑操作能力。桌面打包时会下载固定版本的 Cua Driver 0.30.2，并校验 SHA-256 后放入安装包；也可以设置 `SYNAX_CUA_DRIVER_PATH` 指向已安装的**相同版本**可执行文件。开发模式使用该路径，或从 `PATH` 查找 `cua-driver`（同样要求 0.30.2）。macOS 需在系统设置中为 **Synax** 授予「辅助功能」和「屏幕录制」权限，然后重启 Synax。项目设置页提供驱动状态及权限设置入口。Cua 在界面加载后异步启动，权限缺失或版本不匹配不会阻塞应用其他功能。

默认的「自动」策略直接使用 Cua，**不需要 Jev API，也不会请求 Jev 网络服务**。Jev 辅助模式是可选项：在启动桌面应用的环境中设置 `TYPESAFE_API_KEY`，再在项目的「电脑操作」设置中启用 Jev。控制器从有限的语义动作候选中选择，并在动作后重新观察窗口。`cua-perception` 视觉区域解析默认关闭，其可选扩展**不随 Synax 安装包分发**。

Jev 也可以改走已配置的供应商，而不直接使用 TypeSafe：在「设置 → 供应商」中添加 OpenRouter 连接（OpenAI 兼容协议，Base URL 填 `https://openrouter.ai/v1`，填入你的 OpenRouter API Key），再在「电脑操作」设置里把 Jev 供应商指向该连接。OpenRouter 在 `https://openrouter.ai/api` 提供 TypeSafe 的 System One API，因此 Synax 会先把连接 Base URL 归一化，再由 SDK 拼接 `/v1/systemone`，并使用该连接的 API Key 而非 `TYPESAFE_API_KEY`。模型字段需填写 System One 模型 ID，例如 `jev-1.13`、`typesafe/jev-1.13` 或 `~typesafe/jev-latest`，不是 chat 模型 ID。OpenRouter 提到的 `client.models.list()` 不可用限制对 Synax 无影响，因为 Synax 从不列出模型。供应商留空时保持原有的 TypeSafe 行为。

也可以分别启动这两个服务，例如在两个终端里各跑一个：

```bash
npm run dev:local   # 仅 API，3211 端口，~/.synax/web-dev
npm run dev:client   # 仅 Web，5174 端口，~/.synax/web-dev
```

### 4. 首次配置

1. 在设置中添加模型服务商，填写 API Key 并选择模型。
2. 导入本地项目目录。
3. 使用 Synax 内置 Agent 开始对话。

### 端口

| 变量       | 独立运行默认值 | 开发 Profile | 用途                 |
| ---------- | -------------- | ------------ | -------------------- |
| `PORT`     | `3210`         | `3211`       | API 端口             |
| `WEB_PORT` | `5173`         | `5174`       | Web 开发服务端口     |
| `WEB_HOST` | `0.0.0.0`      | 继承         | Web 开发服务监听地址 |

独立运行默认值适用于 `start:local`；开发 Profile 默认值由原有 `dev`、`dev:all`、`dev:local`、`dev:client` 和 `dev:desktop` 命令自动设置。也可以在启动开发脚本的终端中显式覆盖这些变量。

## 本地 Git 合并请求

导入 Git 项目后，从项目顶部的 **Git** 入口创建本地 MR。选择一个目标和一个或多个有序源分支，使用 Merge commit、Squash 或 Fast-forward only 策略，在隔离工作树中准备候选；整批完成后才更新本地目标。

- 会话内智能合并由专用子 Agent 执行，主会话只保留任务卡和有界摘要；默认等待子任务，子任务可明确切换为后台执行。
- 点击冲突文件直接打开 Monaco 三栏工作台。运行期间只读，停止后可编辑草稿；操作区为停止/继续和取消，检查与目标更新由子 Agent 执行。
- 工作区文件文本查看与编辑共用 Monaco；Markdown、HTML、SVG、图片、PDF、音视频保留预览。合并文件超过编辑预算时只读浏览，更大的文件按字节分片读取。
- 检查命令按“可执行程序 + JSON 参数数组 + 超时”配置。预设可以一键运行，并在所有检查通过后自动合入。检查会执行项目代码，仅配置你信任的命令。
- 目标已检出时，需要创建 MR 时明确允许在其干净工作树中应用；脏目录、运行中的 Agent、分支变动和旧文件版本都会阻止覆盖。
- 可选 Git 管理助手读取当前 MR 并提出冲突补丁，采纳后进入同一查看器复核。它使用项目模型配置，不能直接推送或更新目标；人工 MR 无需模型。
- 停止保留智能合并的检查点，取消放弃此次智能合并并清理专属候选工作树；清理失败可重试，已完成的目标更新不会被取消回退。独立人工 MR 的取消仍保留草稿。记录在本机 Synax 数据目录的 `git-mr` 下。

预设由用户触发，未提供定时触发。子模块等不支持的结构冲突会明确停止并要求外部处理；不会作为文本自动解决。默认不推送远端、不删除源分支。`.DS_Store`、test/beta 向 feature 的合并和 test 分支 `pom.xml` 依赖版本变化会被拒绝。

## 许可

[Apache License 2.0](./LICENSE)
