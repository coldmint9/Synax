<div align="center">

<img width="128" alt="Synax logo" src="electron/resources/icon.png" />

# Synax

A local workspace for coding agents and codebase documentation.

English | [简体中文](./README.zh-CN.md)

</div>

Synax brings agent conversations, source files, diffs, and a terminal into one app. Import a local project to start working with an agent, or generate a Wiki to read through its architecture and follow references back to the code.

The project is in alpha. Wiki and planning are experimental and disabled by default.

## Quick Start

### 1. Requirements

Install [Node.js](https://nodejs.org) **22** (`>=22 <23`), npm 10 or later, and Git. Native dependencies also need Python 3 and a C/C++ build toolchain:

| System  | Build tools                                                                           |
| ------- | ------------------------------------------------------------------------------------- |
| macOS   | Xcode Command Line Tools (`xcode-select --install`)                                   |
| Windows | Visual Studio **2022** Build Tools with the **Desktop development with C++** workload |
| Linux   | GCC, G++, and Make; on Debian/Ubuntu, install `build-essential`                       |

### 2. Install dependencies

```bash
git clone https://github.com/coldmint9/Synax.git
cd Synax
npm install
```

### 3. Start the app

Pick one of the two entry points below. Both share the same local API and agent runtime.

#### Web (browser)

One command starts both the API and the frontend:

```bash
npm run dev:all
```

`npm run dev` is an alias for the same script. The API listens on `3210` and the web development server on `5173`; then open [localhost:5173](http://localhost:5173).

#### Desktop (Electron)

```bash
npm run dev:desktop
```

This compiles the Electron TypeScript sources, starts the API and web servers, waits for both to be ready, and then launches Electron with hot reload (`electronmon`). A desktop window opens automatically; no browser is needed.

To produce an installable desktop build instead of running it in development mode:

```bash
npm run make:desktop
```

Artifacts are written to `out/make/`. Build on the target operating system **and CPU architecture** — libSQL, tree-sitter, and node-pty ship native binaries. Packaged apps include their own runtime, so end users do not need a separate Node.js installation.

You can also start the two servers separately, for example when running the API in one terminal and the frontend in another:

```bash
npm run dev:api   # API only, port 3210
npm run dev:web   # Web only, port 5173
```

### 4. Configure and start working

1. Open Settings and add a model provider, API key, and model.
2. Import a local project directory.
3. Start a conversation with the built-in Synax agent.

### Ports

| Variable   | Default   | Purpose                             |
| ---------- | --------- | ----------------------------------- |
| `PORT`     | `3210`    | API port                            |
| `WEB_PORT` | `5173`    | Web development server port         |
| `WEB_HOST` | `0.0.0.0` | Web development server bind address |

Set these in the shell that launches the development scripts.

## License

[MIT](./LICENSE)
