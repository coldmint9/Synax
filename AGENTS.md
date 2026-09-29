# SYNAX 项目管理细则

## 发布版本自动管理

- `main` 是生产发布分支；向 `main` 推送代码前，应汇总本次变更，并与上一个版本 Tag 对比。
- `.env.version` 中的 `SYNAX_VERSION` 是唯一版本源，`package.json`、lockfile 和代码中的版本号由脚本同步生成，不要手工分别修改。
- 漏洞修复执行 `npm run version:patch`，递增补丁版本号。
- 新增向下兼容功能执行 `npm run version:minor`，递增次版本号。
- 主版本号由作者自行维护：手动修改 `.env.version` 后执行 `npm run version:sync`。
- 版本号采用 `主版本号.次版本号.补丁版本号` 格式；主版本号用于不兼容的超大版本变更，次版本号用于向下兼容的功能更新，补丁版本号用于向下兼容的问题修复。
- `package.json` 不支持环境变量动态插值，因此它的版本号必须由脚本写入合法的静态 SemVer。

## 前端技术架构

- 前端位于 `web/`，使用 React 19、TypeScript、Vite 和 Tailwind CSS 4。
- 页面按 feature 组织在 `web/src/react/features/`；共享 API、状态和 hooks 分别位于 `web/src/lib/api/`、`web/src/react/state/` 和 `web/src/hooks/`。
- 路由使用 `react-router-dom`，全局工作区状态使用 Zustand；后端请求通过领域 API 封装，组件不直接拼接底层请求。
- 测试使用 Vitest、Testing Library 和 `happy-dom`/`jsdom`，Electron 能力通过 `window.electronAPI` 与 lib adapter 隔离。

## UI 架构

- 交互控件优先使用 `@headlessui/react` 原语，由 `web/src/react/components/ui/` 的 `Dialog`、`Field`、`Select`、`Tabs` 和 `Button` 封装统一语义、键盘交互与样式契约。
- 弹窗使用 Headless UI `Dialog`、`DialogBackdrop`、`DialogPanel` 和 `DialogTitle`；业务表单不自建模态层或焦点陷阱。
- 样式以 Tailwind utilities、主题 token 和 feature CSS 为主，使用 `clsx` 组合状态类。
- 新建工作区表单使用 Headless UI Dialog、Tabs、Field、Input、Listbox 和 Button；目录选择由独立目录浏览器返回路径，表单不提供手输路径入口。
