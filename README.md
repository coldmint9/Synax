<div align="center">

# Synax

A local workspace for coding agents and codebase documentation.

English | [简体中文](./README.zh-CN.md)

</div>

Synax brings agent conversations, source files, diffs, and a terminal into one app. Import a local project to start working with an agent, inspect source files, review changes, and verify them in the terminal.

The project is in alpha.

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

#### Production builds

Build the runtime and frontend:

```bash
npm run build
npm run client:build
```

The build outputs are `server-dist/` and `client/dist/`. Use `npm run dev:all` for the browser workflow, or `npm run build:desktop` to package the desktop application.

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

Artifacts are written to `out/make/`. Build on the target operating system **and CPU architecture** — libSQL and node-pty ship native binaries. Packaged apps include their own runtime, so end users do not need a separate Node.js installation.

Full desktop updates use `electron-updater` for feeds and verified downloads: macOS consumes an app ZIP, and Windows consumes the installer ending in `-NSIS.exe`. Developer ID signed macOS apps use the native framework installer. Ad-hoc, unsigned and self-signed apps use Synax's bundle replacement helper: it checks the archive, version and architecture, stages the new app, waits for exit, replaces and relaunches it, and retains the previous bundle until the new app reports healthy. Self-signed apps must retain the same signing identity. Downloads and restarts require confirmation. Older macOS releases that only use the native updater may require one manual installation to enable this path. On Windows, `make:desktop` also generates the NSIS installer; existing Squirrel or portable installations need one manual NSIS installation. Preserve `~/.synax` and the user profile during migration. Legacy Squirrel packages, DMGs and update manifests remain published, and compatible UI updates retain their separate workflow.

Without `SYNAX_MAC_SIGN_IDENTITY`, macOS builds use free ad-hoc signing, including stable tags; no certificate or paid Apple account is needed for the compatibility updater. Ad-hoc signing checks integrity but does not establish publisher identity: release authenticity relies on the HTTPS release source, and first installation remains subject to Gatekeeper approval. Synax does not disable system security settings. For Developer ID signing, configure `SYNAX_MAC_SIGN_IDENTITY` and an imported certificate; CI imports `SYNAX_MAC_CERTIFICATE` (base64 P12) with `SYNAX_MAC_CERTIFICATE_PASSWORD`. Notarization additionally uses `SYNAX_APPLE_ID`, `SYNAX_APPLE_APP_PASSWORD` and `SYNAX_APPLE_TEAM_ID`. Stable Windows builds still require code signing: Windows CI uses `SYNAX_WINDOWS_PUBLISHER`, `SYNAX_WINDOWS_CSC_LINK` and `SYNAX_WINDOWS_CSC_KEY_PASSWORD`; local NSIS builds use the corresponding `CSC_LINK` and `CSC_KEY_PASSWORD`. Update manifest signing is configured separately through `SYNAX_UPDATE_SIGNING_KEY` and `SYNAX_UPDATE_PUBLIC_KEY`. Update feeds are isolated by platform and architecture. Latest advances only when macOS x64/arm64 and Windows x64 artifacts are complete; rerunning an older complete release does not promote it again.

Computer Use is available in the Electron desktop app through an app-hosted Cua Driver. Desktop packaging downloads a pinned Cua Driver 0.30.2 executable and verifies its SHA-256 before bundling; `SYNAX_CUA_DRIVER_PATH` may point to an already installed **matching** executable. Development mode uses that override or finds `cua-driver` on `PATH` (the executable must also be 0.30.2). On macOS, grant **Synax** Accessibility and Screen Recording permissions in System Settings, then relaunch Synax. The project settings page displays the Driver status and permission shortcuts. Cua starts asynchronously after the UI loads; a missing grant or incompatible binary does not block the rest of the app.

The default **Auto** strategy uses Direct Cua without a Jev account or network request. Jev-assisted operation is optional: set `TYPESAFE_API_KEY` in the environment that launches the desktop app, then enable Jev in the project Computer Use settings. The controller chooses from bounded semantic actions and verifies a fresh window state after each action. `cua-perception` visual-region parsing is optional and disabled by default; the visual extension is **not** bundled in the Synax installer.

Jev can also run through a configured provider instead of TypeSafe. Add an OpenRouter connection under **Settings -> Providers** (OpenAI-compatible format, Base URL `https://openrouter.ai/v1`, your OpenRouter API key), then select that provider for Jev in the Computer Use settings. OpenRouter serves the TypeSafe System One API at `https://openrouter.ai/api`, so Synax normalizes the connection base URL before the SDK appends `/v1/systemone`, and the connection API key is used instead of `TYPESAFE_API_KEY`. The Jev model field takes a System One model id such as `jev-1.13`, `typesafe/jev-1.13`, or `~typesafe/jev-latest`, not a chat model id. The `client.models.list()` limitation noted by OpenRouter does not affect Synax, which never lists models. Leaving the Jev provider unset keeps the original TypeSafe behavior.

You can also start the two servers separately, for example when running the API in one terminal and the frontend in another:

```bash
npm run dev:local   # API only, port 3211, ~/.synax/web-dev
npm run dev:client   # Web only, port 5174, ~/.synax/web-dev
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

The standalone defaults apply to `start:local`. The development profile defaults are applied automatically by the existing `dev`, `dev:all`, `dev:local`, `dev:client`, and `dev:desktop` commands. You can still override them in the shell that launches the development scripts.

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
