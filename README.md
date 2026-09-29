<div align="center">

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

The entry points below can be started as needed. Development commands use isolated profiles by default, so the production desktop app, Web development build, and Electron development build do not share runtime data.

#### Web (browser)

One command starts both the API and the frontend:

```bash
npm run dev:all
```

`npm run dev` is an alias for the same script. The Web development profile uses the API on `3211`, the web development server on `5174`, and the data root `~/.synax/web-dev`; then open [localhost:5174](http://localhost:5174).

#### Production Web mode for everyday use (recommended)

```bash
npm run build
npm run web:build
npm run start:web
```

This serves the built frontend on port `5173` after the local runtime reports ready, with realtime observations on a shared WebSocket. Keep `dev:all` for development. Do not start two runtime owners for the same `DATA_ROOT`; set `SYNAX_API_ORIGIN=http://127.0.0.1:<port>` to explicitly attach to an existing compatible runtime instead.

For HTTP/2, provide a TLS certificate for `localhost` that your browser trusts:

```bash
WEB_TLS_CERT=/absolute/path/localhost-cert.pem WEB_TLS_KEY=/absolute/path/localhost-key.pem npm run start:web
```

The TLS entry uses HTTP/2 for ordinary requests/assets and compatible HTTP/1.1 upgrades for WebSocket. Without certificates, HTTP/1.1 plus shared WebSocket is supported. The app never installs a root certificate, bypasses certificate validation, or relaxes authorization. When changing `WEB_PORT`, an independently started backend must allow the same origin port.

#### Local storage maintenance (read-only by default)

Inspect database pages, freelist, WAL, FTS, cache, replay, and process-receipt categories:

```bash
npm run storage:report
```

Maintenance is not automatic. Point it at a copy and stop the runtime first:

```bash
SYNAX_DB_PATH=/absolute/path/context.db npm run storage:maintain
SYNAX_DB_PATH=/absolute/path/context.db npm run storage:compact
```

The command creates a consistent `VACUUM INTO` backup and refuses to overwrite an existing backup. It does not remove authoritative messages, events, billing, checkpoints, forks, undo records, or asset references. Never run mutating maintenance against a live `~/.synax/context.db`.

#### Desktop (Electron)

```bash
npm run dev:desktop
```

This compiles the Electron TypeScript sources, starts the API and web servers, waits for both to be ready, and then launches Electron with hot reload (`electronmon`). A desktop window opens automatically; no browser is needed.

The installed production desktop app continues to use `~/.synax`, while the Web development profile uses `~/.synax/web-dev`, so the two runtimes do not share the database, sessions, runtime token, or project index. If you also run the Electron development build, `npm run dev:desktop` automatically uses `~/.synax/desktop-dev`, keeps Vite on `5173`, and lets the Sidecar API use an OS-assigned port. `DATA_ROOT`, `PORT`, and `WEB_PORT` can be used to override the active profile defaults.

To produce an installable desktop build instead of running it in development mode:

```bash
npm run make:desktop
```

Artifacts are written to `out/make/`. Build on the target operating system **and CPU architecture** — libSQL, tree-sitter, and node-pty ship native binaries. Packaged apps include their own runtime, so end users do not need a separate Node.js installation.

Computer Use is available in the Electron desktop app through an app-hosted Cua Driver. Desktop packaging downloads a pinned Cua Driver 0.30.2 executable and verifies its SHA-256 before bundling; `SYNAX_CUA_DRIVER_PATH` may point to an already installed **matching** executable. Development mode uses that override or finds `cua-driver` on `PATH` (the executable must also be 0.30.2). On macOS, grant **Synax** Accessibility and Screen Recording permissions in System Settings, then relaunch Synax. The project settings page displays the Driver status and permission shortcuts. Cua starts asynchronously after the UI loads; a missing grant or incompatible binary does not block the rest of the app.

The default **Auto** strategy uses Direct Cua without a Jev account or network request. Jev-assisted operation is optional: set `TYPESAFE_API_KEY` in the environment that launches the desktop app, then enable Jev in the project Computer Use settings. The controller chooses from bounded semantic actions and verifies a fresh window state after each action. `cua-perception` visual-region parsing is optional and disabled by default; the visual extension is **not** bundled in the Synax installer.

Jev can also run through a configured provider instead of TypeSafe. Add an OpenRouter connection under **Settings -> Providers** (OpenAI-compatible format, Base URL `https://openrouter.ai/api/v1`, your OpenRouter API key), then select that provider for Jev in the Computer Use settings. OpenRouter serves the TypeSafe System One API at `https://openrouter.ai/api`, so Synax normalizes the connection base URL before the SDK appends `/v1/systemone`, and the connection API key is used instead of `TYPESAFE_API_KEY`. The Jev model field takes a System One model id such as `jev-1.13`, `typesafe/jev-1.13`, or `~typesafe/jev-latest`, not a chat model id. The `client.models.list()` limitation noted by OpenRouter does not affect Synax, which never lists models. Leaving the Jev provider unset keeps the original TypeSafe behavior.

You can also start the two servers separately, for example when running the API in one terminal and the frontend in another:

```bash
npm run dev:api   # API only, port 3211, ~/.synax/web-dev
npm run dev:web   # Web only, port 5174, ~/.synax/web-dev
```

### 4. Configure and start working

1. Open Settings and add a model provider, API key, and model.
2. Import a local project directory.
3. Start a conversation with the built-in Synax agent.

### Ports

| Variable   | Standalone default | Development profile | Purpose                         |
| ---------- | ------------------ | ------------------- | ------------------------------- |
| `PORT`     | `3210`             | `3211`              | API port                        |
| `WEB_PORT` | `5173`             | `5174`              | Web development server port     |
| `WEB_HOST` | `0.0.0.0`          | inherited           | Web development server bind address |

The standalone defaults apply to `start:api` and `start:web`. The development profile defaults are applied automatically by the existing `dev`, `dev:all`, `dev:api`, `dev:web`, and `dev:desktop` commands. You can still override them in the shell that launches the development scripts.

## Local Git merge requests

Open **Git** from an imported project's header to create a local MR. Select a target and one or more ordered sources, using merge commits, per-source squash, or fast-forward-only. Synax prepares the entire batch in an isolated worktree before updating the local target.

- Conflicts use the same file viewer as sessions: three-way comparison, per-line choices, direct edits, undo/redo, and persisted drafts/decisions.
- Configure checks as an executable, JSON argument array and timeout. One-click presets can apply the candidate after every check passes. Checks execute project code; configure only trusted commands.
- Updating a checked-out target requires explicit opt-in when creating the MR and a clean, idle target worktree. Stale branches and file revisions are rejected.
- The optional Git Manager uses the configured model to inspect the bound MR and propose patches for review. It cannot directly publish branches or push. Manual MR works without a model.
- Failed/interrupted operations can be reconciled and resumed. Cancellation preserves the candidate worktree and drafts. Local records live under the Synax data directory's `git-mr` folder.

Automation currently means manually triggered one-click presets, not scheduled runs. Unsupported structural conflicts, such as submodules, stop explicitly for external resolution. The feature does not push or delete source branches. Tracked `.DS_Store` files and merges from test/beta into feature branches are rejected.

## License

[Apache License 2.0](./LICENSE)
