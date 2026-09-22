<div align="center">

<img width="128" alt="Synax logo" src="electron/resources/icon.png" />

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

| 变量       | 默认值     | 用途                     |
| ---------- | ---------- | ------------------------ |
| `PORT`     | `3210`     | API 端口                 |
| `WEB_PORT` | `5173`     | Web 开发服务端口         |
| `WEB_HOST` | `0.0.0.0`  | Web 开发服务监听地址     |

这些变量需要在启动开发脚本的终端中设置。

## 许可

[MIT](./LICENSE)
