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

## Interactive conversation prototypes

Write HTML or a default-export React/TSX component in the authorized workspace and emit a complete `synax-prototype` fenced JSON declaration with `sourcePath`, `title` and `sourceKind` (`html` or `react`). Up to three prototypes per completed assistant message are compiled once and saved in that message's metadata. No publication tools, artifact APIs, revision/state tables, QA, screenshots, feedback or exports are used. Existing legacy records are left untouched and not rendered.

Conversation cards render directly. Titles appear as a top hover/focus overlay (always readable on touch devices); interaction state resets when the preview restarts. Only ready, theme and bounded height messages cross the preview boundary. HTML/React interactions stay inside the preview.

**Security:** retain workspace path/symlink/secret protection, fixed dependencies, bounded worker compilation, CSP and opaque Web sandbox. Browser sandboxing does not guarantee hard network/CPU isolation; do not enter secrets. Desktop previews retain ephemeral Electron sessions, denied navigation/network/permissions and no Node/host IPC privileges. No npm installs, project build scripts or runtime CDN are executed. Authoring examples are in `api/skills/builtin/interactive-artifacts/`.
