<div align="center">

<img alt="Synax" src="web/public/synax-github-cover.png" />

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
