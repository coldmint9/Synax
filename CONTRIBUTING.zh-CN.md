# 参与贡献

[English](./CONTRIBUTING.md) | 简体中文

感谢你对 Synax 的关注。本文档说明如何参与项目开发。

## 前置要求

- Node.js 24+
- npm 10+
- Git
- 原生编译工具链（macOS 需要 Xcode Command Line Tools，用于 tree-sitter）

## 本地开发

```bash
git clone https://github.com/coldmint9/Synax.git
cd Synax
npm install
npm run dev
```

API 启动在 `http://localhost:3210`，Web 启动在 `http://localhost:5173`。

## 项目结构

```
api/        后端：Hono 路由、SQLite、Drizzle ORM、Agent Runtime、Wiki 服务
web/        前端：React 19、Vite、HeroUI、Zustand
electron/   桌面端：Electron 壳、IPC、API sidecar
scripts/    开发脚本
docs/       设计文档
```

## 提交前检查

提交 PR 前请确保以下命令通过：

```bash
npm run typecheck   # TypeScript 类型检查
npm run test        # 运行测试
npm run lint        # ESLint 检查
```

## 分支与提交

- 从 `main` 创建功能分支，命名格式：`feat/xxx`、`fix/xxx`、`refactor/xxx`
- Commit message 使用 [Conventional Commits](https://www.conventionalcommits.org/) 风格：

  ```
  feat(wiki): add document export to PDF
  fix(agent-runtime): prevent duplicate tool calls in streaming
  refactor(api): simplify provider resolution logic
  docs(readme): update quick start section
  ```

- 保持提交粒度小且聚焦，一个 PR 解决一个问题。

## Pull Request 规范

1. PR 标题简洁，不超过 70 个字符。
2. 描述中包含：
   - 变更摘要（做了什么、为什么做）。
   - 验证方式（测试命令或手动步骤）。
   - 如果涉及 UI 变更，附上截图。
3. 较大的改动请先开 Issue 或 Discussion 讨论设计方案。

## 代码风格

- TypeScript strict mode，不使用 `any`（除非有充分理由）。
- 后端路由放在 `api/routes/`，业务逻辑放在 `api/services/`。
- 前端组件优先使用 [HeroUI](https://heroui.com) v3 组件库。
- 状态管理使用 Zustand，store 放在 `web/src/react/state/`。
- 文件命名：组件用 PascalCase，工具函数用 camelCase。
- 不写多余注释，代码自解释；只在 "为什么" 不明显时加注释。

## 测试

- 修改运行时行为、持久化逻辑、路由契约或 Wiki 生成时，需要添加或更新测试。
- API 测试：Vitest，放在 `__tests__/` 目录或 `.test.ts` 后缀文件中。
- Web 测试：Vitest + React Testing Library（`web/vitest.config.ts`）。

## 数据库变更

- 迁移文件放在 `api/db/migrations/`，使用原始 SQL。
- 迁移必须是幂等的（使用 `CREATE TABLE IF NOT EXISTS` 等）。
- 启动时按顺序执行，无需手动运行迁移命令。

## 报告问题

开 Issue 时请包含：

- 问题描述和复现步骤。
- 期望行为 vs 实际行为。
- 环境信息（OS、Node 版本、浏览器）。
- 相关日志或截图。

## License

贡献的代码将以 [MIT License](./LICENSE) 发布。
