<div align="center">

# Synax

在本地用 Agent 写代码、整理项目文档。

[English](./README.md) | 简体中文

</div>

Synax 把 Agent 对话、源码、文件差异和终端放在同一个应用里。导入本地项目后，可以直接开始任务，也可以先从源码生成 Wiki，了解项目结构，再沿着文档中的引用查看代码。

项目目前处于 alpha 阶段。Wiki 和规划功能仍在实验中，默认关闭。

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

下面两种方式二选一，二者共用同一套本地 API 与 Agent 运行服务。

#### Web 端（浏览器）

一条命令同时启动 API 与前端：

```bash
npm run dev:all
```

`npm run dev` 是同一脚本的别名。API 监听 `3210` 端口，Web 开发服务监听 `5173` 端口，然后打开 [localhost:5173](http://localhost:5173) 即可使用。

#### 日常使用的 Web 生产模式（推荐）

```bash
npm run build
npm run web:build
npm run start:web
```

生产模式使用构建后的前端，等待本地运行服务 ready 后再监听 `5173`，实时订阅通过共享 WebSocket 传输。`dev:all` 仍用于开发。不要同时启动两个使用相同 `DATA_ROOT` 的运行服务；若已有兼容的运行服务，可通过 `SYNAX_API_ORIGIN=http://127.0.0.1:<端口>` 显式连接。

如需 HTTP/2，为 `localhost` 配置浏览器信任的 TLS 证书，然后启动：

```bash
WEB_TLS_CERT=/绝对路径/localhost-cert.pem WEB_TLS_KEY=/绝对路径/localhost-key.pem npm run start:web
```

TLS 入口让普通请求和静态资源使用 HTTP/2，WebSocket 使用兼容的 HTTP/1.1 upgrade；无证书时仍支持 HTTP/1.1 + 共享 WebSocket。程序不会安装根证书、绕过证书验证或降低鉴权要求。更换 `WEB_PORT` 时，自行连接的后端也必须配置相同的允许来源端口。

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

如果需要打包出可安装的桌面应用，而不是以开发模式运行：

```bash
npm run make:desktop
```

产物保存在 `out/make/`。需要在目标**操作系统和 CPU 架构**上构建，libSQL、tree-sitter 和 node-pty 都包含原生二进制。打包后的应用自带运行时，使用者无需另外安装 Node.js。

也可以分别启动这两个服务，例如在两个终端里各跑一个：

```bash
npm run dev:api   # 仅 API，3210 端口
npm run dev:web   # 仅 Web，5173 端口
```

### 4. 首次配置

1. 在设置中添加模型服务商，填写 API Key 并选择模型。
2. 导入本地项目目录。
3. 使用 Synax 内置 Agent 开始对话。

### 端口

| 变量       | 默认值    | 用途                 |
| ---------- | --------- | -------------------- |
| `PORT`     | `3210`    | API 端口             |
| `WEB_PORT` | `5173`    | Web 开发服务端口     |
| `WEB_HOST` | `0.0.0.0` | Web 开发服务监听地址 |

这些变量需要在启动开发脚本的终端中设置。

## 本地 Git 合并请求

导入 Git 项目后，从项目顶部的 **Git** 入口创建本地 MR。选择一个目标和一个或多个有序源分支，使用 Merge commit、Squash 或 Fast-forward only 策略，在隔离工作树中准备候选；整批完成后才更新本地目标。

- 冲突文件使用与会话共用的文件查看器，支持三栏对比、行级混选、直接编辑、撤销/重做、草稿与行决定恢复。
- 检查命令按“可执行程序 + JSON 参数数组 + 超时”配置。预设可以一键运行，并在所有检查通过后自动合入。检查会执行项目代码，仅配置你信任的命令。
- 目标已检出时，需要创建 MR 时明确允许在其干净工作树中应用；脏目录、运行中的 Agent、分支变动和旧文件版本都会阻止覆盖。
- 可选 Git 管理助手读取当前 MR 并提出冲突补丁，采纳后进入同一查看器复核。它使用项目模型配置，不能直接推送或更新目标；人工 MR 无需模型。
- 失败或中断后可核验并恢复。取消会保留候选工作树与草稿，便于检查。记录在本机 Synax 数据目录的 `git-mr` 下。

当前自动化为手动一键预设，未提供定时触发。子模块等不支持的结构冲突会明确停止并要求外部处理；不会作为文本自动解决。默认不推送远端、不删除源分支。`.DS_Store` 以及 test/beta 向 feature 的合并会被拒绝。

## 许可

[MIT](./LICENSE)
