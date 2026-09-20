<div align="center">

# Synax

<img width="898" height="80" alt="Synax" src="https://github.com/user-attachments/assets/ba60d60b-ee63-4409-b158-33754f4efe80" />

A local workspace for coding agents and codebase documentation.

English | [简体中文](./README.zh-CN.md)

</div>

Synax brings agent conversations, source files, diffs, and a terminal into one app. Import a local project to start working with an agent, or generate a Wiki to read through its architecture and follow references back to the code.

The project is in alpha. Wiki and planning are experimental and disabled by default. External agent integrations are still being developed, and data formats may change between versions.

## Features

### Code, run, and review in one workspace

The built-in agent can search a repository, edit files, apply patches, and run commands. Source files, diffs, terminals, and Git worktrees sit alongside the conversation. Tool calls and command output appear as the task runs, with permission requests for operations that need approval.

### Choose your model or coding agent

Use the Synax agent with your own model API, or connect an external agent such as Codex or Claude Code. Custom endpoints support Chat Completions, Responses, and Anthropic Messages. Model selection and reasoning effort are available in the conversation composer where supported. External agent integrations are still in development.

### Delegate work to subagents

The built-in agent can hand code exploration or review to a child agent with its own context. Child sessions keep their own work history and return results to the parent, so a repository search does not fill the main conversation with every intermediate step. Specialized agents can also be given a defined set of tools and a limited file write scope.

### Bring your own tools and skills

Connect MCP servers and load Skills for project-specific tasks. The project settings include local discovery, connected MCP tools, and a Skill marketplace. Enable the tools and instructions a project needs without adding them to every conversation manually.

### Search the web and check pages in a browser

Agents can search for documentation and return source links. Search supports provider-native search, DuckDuckGo, Brave, Tavily, and custom JSON APIs, with fallback when a configured channel is unavailable.

Browser tools can open pages, click controls, fill forms, take screenshots, and inspect console messages and network requests. This lets an agent check a running web app as part of a coding task. Browser operations require a supported browser installed locally.

### Work with images, audio, video, and files

Attach a screenshot, document, audio clip, or video to a conversation when the selected model supports it. The built-in agent also has tools for image generation and editing, speech synthesis, audio transcription, and video generation. Generated media can be previewed, downloaded, and reused in later requests. Input formats and generation options depend on the configured provider and model.

### Continue long conversations

Sessions and execution history are saved locally. The runtime can compact older context while retaining recent steps and selected requirements, decisions, and results. The conversation view shows context usage and provider-reported cache statistics when available, so you can see how much context a task is using.

### Generate a Wiki that points back to the code

Synax uses tree-sitter to analyze source files and symbols, then generates project documentation with code references. Read the document tree, search its contents, view diagrams, or export Markdown. When code changes, refresh checks identify affected documents and produce drafts for review.

Wiki also includes experimental planning views that break work into tasks and show their dependencies. Wiki and planning are disabled by default; enable **Wiki (Experimental)** in Settings to try them.

### Work locally, from the interface you prefer

Use the browser app, an Electron desktop build, or the CLI. They share the local API and agent runtime. Desktop builds target macOS, Windows, and Linux; Windows also supports projects inside WSL2. The CLI provides interactive conversations, one-shot commands, and JSONL output for scripts.

Project records, settings, and conversation history are stored locally. When you use a remote model, the prompts and code included in its context are sent to that provider.

## Run from source

You need Node.js **22** (`>=22 <23`), npm 10 or later, and Git. Native dependencies also need Python 3 and a C/C++ build toolchain:

| System  | Build tools                                                                           |
| ------- | ------------------------------------------------------------------------------------- |
| macOS   | Xcode Command Line Tools (`xcode-select --install`)                                   |
| Windows | Visual Studio **2022** Build Tools with the **Desktop development with C++** workload |
| Linux   | GCC, G++, and Make; on Debian/Ubuntu, install `build-essential`                       |

```bash
git clone https://github.com/coldmint9/Synax.git
cd Synax
npm ci --include=dev
npm run dev
```

Open [localhost:5173](http://localhost:5173). The API runs on port `3210`.

1. Open Settings and add a model provider, API key, and model.
2. Import a local project directory.
3. Start a conversation with the built-in Synax agent.

To try documentation generation, enable **Wiki (Experimental)** in Settings, configure its models, then open the project's Wiki page.

For the desktop app, run this instead of `npm run dev`:

```bash
npm run dev:desktop
```

This starts Electron along with the API and web development servers. Packaged desktop builds include their own runtime and do not need a separate Node.js installation.

## Models and agents

The settings page includes presets for OpenAI, Anthropic, DeepSeek, OpenRouter, and xAI. You can also add a custom endpoint using one of these API formats:

- OpenAI Chat Completions
- OpenAI Responses
- Anthropic Messages

Choose a provider and model for the built-in agent. Wiki model settings are configured separately. Available features depend on the model and endpoint.

Synax also has integrations for external coding agents, including Codex, Claude Code, and ACP clients. These require the corresponding tool to be installed and configured on your machine. Integration support is still in development.

## Windows and WSL2

The Windows desktop app can import projects from a WSL2 distribution. Select **WSL2** in the project dialog, choose a distribution, and enter a Linux path such as `/home/user/project`. Shell commands, Git, and worktrees run inside that distribution.

A workspace must use directories from the same environment: Windows, or one WSL2 distribution. WSL2 projects currently work with the built-in Synax agent only.

## Command line

Build the CLI from the repository root:

```bash
npm run build
node server-dist/cli.cjs --help
node server-dist/cli.cjs backends
node server-dist/cli.cjs exec --work-dir /path/to/project "Explain how this project starts"
```

The CLI connects to a local runtime or starts one if needed. It uses the current directory as its working directory unless you pass `--work-dir`, and registers the project when necessary. Running it without a subcommand starts an interactive conversation.

Use `--json` for a final result or `--jsonl` for streamed events. The `rpc` command accepts JSONL over stdin and writes responses and events to stdout.

For an existing server, set `SYNAX_API` or pass `--url`. Authentication can be supplied through `SYNAX_RUNTIME_TOKEN`, `--token`, or `--token-file`; the local runtime stores its token in `${DATA_ROOT}/runtime-access-token`.

## Local data and configuration

Data is stored in `~/.synax` by default (`%USERPROFILE%\.synax` on Windows). Set `DATA_ROOT` to use a different directory.

The API reads `.env` during source development. Model connections are configured in the app; no `.env` file is needed for the default setup.

| Variable                | Default           | Purpose                                        |
| ----------------------- | ----------------- | ---------------------------------------------- |
| `DATA_ROOT`             | `~/.synax`        | Database, settings, and logs                   |
| `PORT`                  | `3210`            | API port                                       |
| `WEB_PORT`              | `5173`            | Web development server port                    |
| `WEB_HOST`              | `0.0.0.0`         | Web development server bind address            |
| `LOG_LEVEL`             | `info`            | API log level                                  |
| `CONFIG_ENCRYPTION_KEY` | Built-in fallback | Encryption key for stored provider credentials |

Set `WEB_PORT` and `WEB_HOST` in the shell that launches the development scripts. Before saving provider credentials, set your own `CONFIG_ENCRYPTION_KEY` and keep it when moving your data; changing it prevents existing credentials from being decrypted. `Synax_CONFIG_SECRET` is also accepted as a fallback variable.

## Build the desktop app

```bash
npm run make:desktop
```

Install dependencies and build on the target operating system **and CPU architecture**. libSQL, tree-sitter, and node-pty contain native binaries.

| Target              | CI runner        | Output                     |
| ------------------- | ---------------- | -------------------------- |
| macOS Apple Silicon | `macos-15`       | DMG and ZIP                |
| macOS Intel         | `macos-15-intel` | DMG and ZIP                |
| Windows x64         | `windows-2022`   | Squirrel installer and ZIP |
| Linux x64           | `ubuntu-latest`  | ZIP                        |

Artifacts are written to `out/make/`. Use `npm run build:desktop` if you only need an unpacked app. Signing and notarization are not configured, so the OS may warn when opening a build.

Packaged macOS and Windows apps check GitHub Releases for updates. Use **Help → Software Update…** (`帮助 → 软件更新…`) to check manually. Compatible UI updates take effect after a restart and can fall back to the previous UI if loading fails. Linux does not currently have this updater.

Desktop releases use `v*` tags; UI-only releases use `ui-v*` tags. The [desktop workflow](./.github/workflows/build-desktop.yml) and [UI workflow](./.github/workflows/build-ui-release.yml) contain the build and release steps. Desktop releases publish successful platforms even if another platform fails. Reruns can fill an empty release or add missing platforms while preserving already published platform files; update manifests are uploaded after their installers. UI releases must match a published desktop version and cannot include backend or Electron changes. Update downloads use HTTPS and hash checks; they rely on the repository's release publishing access rather than an independent content signature.

Every push to `main` also builds all four desktop targets. After the builds finish, the workflow publishes the platforms whose builds and checks succeeded to [Latest Preview](https://github.com/coldmint9/Synax/releases/tag/preview), a rolling prerelease tagged `preview`. Its notes identify the available platforms, base app version, commit, and Actions run. A failed platform does not block successful platforms; if all platforms fail, the existing preview is kept. Download and install previews manually; stable automatic updates exclude prereleases. Older builds cannot overwrite a newer main commit's preview, and the release stays in draft while its assets are being replaced. Running **Build Desktop** manually on `main` can retry a failed preview publication.

## Development

The backend uses Hono, libSQL, and Drizzle. The frontend uses React, Vite, HeroUI, and Zustand. Electron hosts the desktop app; tree-sitter parses source files.

```text
api/        API routes, database, code analysis, Wiki, and agent runtime
web/        React app
electron/   Desktop app and updater
cli/        Terminal client
scripts/    Development, build, release, and smoke-test scripts
```

| Command                      | Purpose                                   |
| ---------------------------- | ----------------------------------------- |
| `npm run dev:api`            | Start the API                             |
| `npm run dev:web`            | Start the web development server          |
| `npm run build`              | Build the API and CLI into `server-dist/` |
| `npm run start`              | Run the built API                         |
| `npm run web:build`          | Build the frontend into `web/dist/`       |
| `npm run typecheck`          | Check backend TypeScript                  |
| `npm run typecheck:cli`      | Check CLI TypeScript                      |
| `npm run lint`               | Lint API code                             |
| `npm test`                   | Run backend, CLI, and desktop unit tests  |
| `npm run --prefix web test`  | Run frontend tests                        |
| `npm run test:desktop:smoke` | Check a packaged app                      |

For a bug report, include reproduction steps, your OS and Node.js version, and relevant logs or screenshots. For a pull request, explain the change and how you checked it. Add tests for changes to runtime behavior, persistence, API contracts, or Wiki generation. Discuss larger changes in an issue first.

## License

[MIT](./LICENSE)
