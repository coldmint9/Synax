# Contributing

English | [简体中文](./CONTRIBUTING.zh-CN.md)

Thank you for your interest in Synax. This document explains how to participate in development.

## Prerequisites

- Node.js 24+
- npm 10+
- Git
- Native build toolchain (macOS requires Xcode Command Line Tools for tree-sitter)

## Local Development

```bash
git clone https://github.com/coldmint9/Synax.git
cd Synax
npm install
npm run dev
```

API starts at `http://localhost:3210`, web app at `http://localhost:5173`.

## Project Structure

```
api/        Backend: Hono routes, SQLite, Drizzle ORM, Agent Runtime, Wiki services
web/        Frontend: React 19, Vite, HeroUI, Zustand
electron/   Desktop: Electron shell, IPC, API sidecar
scripts/    Development scripts
docs/       Design documents
```

## Pre-submit Checks

Run these before opening a PR:

```bash
npm run typecheck   # TypeScript type checking
npm run test        # Run tests
npm run lint        # ESLint
```

## Branch and Commit

- Branch from `main` with a descriptive name: `feat/xxx`, `fix/xxx`, `refactor/xxx`
- Use [Conventional Commits](https://www.conventionalcommits.org/):

  ```
  feat(wiki): add document export to PDF
  fix(agent-runtime): prevent duplicate tool calls in streaming
  refactor(api): simplify provider resolution logic
  docs(readme): update quick start section
  ```

- Keep commits small and focused — one PR solves one problem.

## Pull Request Guidelines

1. PR title under 70 characters.
2. Description includes:
   - Summary of what changed and why.
   - How to verify (test commands or manual steps).
   - Screenshots if UI changed.
3. For larger changes, open an Issue or Discussion first.

## Code Style

- TypeScript strict mode; avoid `any` without justification.
- Backend routes in `api/routes/`, business logic in `api/services/`.
- Frontend components use [HeroUI](https://heroui.com) v3.
- State management with Zustand in `web/src/react/state/`.
- File naming: PascalCase for components, camelCase for utilities.
- No unnecessary comments — only explain the "why" when non-obvious.

## Testing

- Add or update tests when touching runtime behavior, persistence, route contracts, or wiki generation.
- API tests: Vitest, `__tests__/` directories or `.test.ts` suffix.
- Web tests: Vitest + React Testing Library (`web/vitest.config.ts`).

## Database Changes

- Migration files go in `api/db/migrations/` as raw SQL.
- Must be idempotent (`CREATE TABLE IF NOT EXISTS`, etc.).
- Executed sequentially on startup — no manual migration step needed.

## Reporting Issues

Please include:

- Description and reproduction steps.
- Expected vs actual behavior.
- Environment info (OS, Node version, browser).
- Relevant logs or screenshots.

## License

Contributions are released under the [MIT License](./LICENSE).
