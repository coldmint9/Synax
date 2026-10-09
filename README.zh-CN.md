<div align="center">

# Synax

在本地用 Agent 写代码、整理项目文档。

[English](./README.md) | 简体中文

</div>

Synax 把 Agent 对话、源码、文件差异和终端放在同一个应用里。导入本地项目后，可以直接开始任务，查看源码、审查改动，并在终端中验证结果。

项目目前处于 alpha 阶段。

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

#### 本地存储维护（默认只读）

查看数据库占用、freelist、WAL、FTS、缓存、回放和进程台账分类：

```bash
npm run storage:report
```

维护命令默认不会执行。使用 `SYNAX_DB_PATH` 指定副本并在运行服务完全停止后执行：

```bash
SYNAX_DB_PATH=/绝对路径/context.db npm run storage:maintain
SYNAX_DB_PATH=/绝对路径/context.db npm run storage:compact
```

命令会先通过 `VACUUM INTO` 创建一致性备份，拒绝覆盖已有备份；不会清理权威消息、事件、计费、检查点、分叉、撤销或资源引用。不要对正在运行的 `~/.synax/context.db` 执行变更命令。

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

桌面整包更新使用 `electron-updater`：macOS 使用应用 ZIP，Windows 使用以 `-NSIS.exe` 结尾的安装包，`make:desktop` 在 Windows 上会同时生成 NSIS 产物。旧 Windows Squirrel 安装和便携版需要手动安装一次 NSIS 版。Synax 不对当前 macOS 应用进行 Developer ID 签名前置检查；实际安装仍受更新框架与系统的签名规则约束。迁移时保留 `~/.synax` 和用户配置；后续更新仍需确认下载和重启。旧 Squirrel 包、DMG 和更新清单继续发布，兼容界面更新保留独立流程。

稳定 Tag 构建要求代码签名。macOS 使用 `SYNAX_MAC_SIGN_IDENTITY` 和已导入的 Developer ID 证书；CI 通过 `SYNAX_MAC_CERTIFICATE`（base64 P12）与 `SYNAX_MAC_CERTIFICATE_PASSWORD` 导入，公证使用 `SYNAX_APPLE_ID`、`SYNAX_APPLE_APP_PASSWORD` 和 `SYNAX_APPLE_TEAM_ID`。Windows CI 使用 `SYNAX_WINDOWS_PUBLISHER`、`SYNAX_WINDOWS_CSC_LINK` 与 `SYNAX_WINDOWS_CSC_KEY_PASSWORD`；本地 NSIS 构建使用对应的 `CSC_LINK` 和 `CSC_KEY_PASSWORD`。缺少必需签名配置时稳定构建失败，预览版可手动测试。更新清单按平台和架构隔离，只有 macOS x64/arm64 与 Windows x64 产物齐全时才推进 latest；旧完整版本重跑不会再次置顶。

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

- 冲突文件使用与会话共用的文件查看器，支持三栏对比、行级混选、直接编辑、撤销/重做、草稿与行决定恢复。
- 检查命令按“可执行程序 + JSON 参数数组 + 超时”配置。预设可以一键运行，并在所有检查通过后自动合入。检查会执行项目代码，仅配置你信任的命令。
- 目标已检出时，需要创建 MR 时明确允许在其干净工作树中应用；脏目录、运行中的 Agent、分支变动和旧文件版本都会阻止覆盖。
- 可选 Git 管理助手读取当前 MR 并提出冲突补丁，采纳后进入同一查看器复核。它使用项目模型配置，不能直接推送或更新目标；人工 MR 无需模型。
- 失败或中断后可核验并恢复。取消会保留候选工作树与草稿，便于检查。记录在本机 Synax 数据目录的 `git-mr` 下。

当前自动化为手动一键预设，未提供定时触发。子模块等不支持的结构冲突会明确停止并要求外部处理；不会作为文本自动解决。默认不推送远端、不删除源分支。`.DS_Store` 以及 test/beta 向 feature 的合并会被拒绝。

## 许可

[Apache License 2.0](./LICENSE)
