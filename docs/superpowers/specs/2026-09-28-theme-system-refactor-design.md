# Synax 主题系统重构设计

- 日期：2026-09-28
- 状态：待用户评审
- 范围：Web/Electron UI 主题系统、外观设置、可导入主题配置

## 1. 背景与目标

当前 Synax 已有 `theme`、`accentColor`、`resolvedTheme` 和 `tokens.css`，但主题能力仍然分散在 `appearance.ts`、`shellStore`、全局 CSS 变量和若干组件内部。主题色通过运行时计算生成，UI 组件同时依赖语义变量、旧变量和局部硬编码颜色，导致主题视觉难以整体调整，也无法通过外部配置文件复用或交换主题。

本次重构的目标是：

1. 建立版本化、可校验、可扩展的主题配置契约。
2. 将 UI 组件配色从具体主题实现中解耦，只依赖语义 token。
3. 支持主题配置文件导入、导出、即时预览和本地持久化。
4. 保持现有浅色、深色、跟随系统和主题色预设的行为兼容。
5. 为 Web、Electron、终端等不同渲染表面提供统一主题读取方式。

本次不改变布局、业务流程或组件交互模型；字体、字号、间距等视觉 token 只预留扩展位置，第一阶段不要求全部迁移。

## 2. 当前实现与问题

当前主题相关能力主要包括：

- `web/src/lib/appearance.ts`：主题模式、accent 色归一化、accent palette 计算、CSS 变量写入。
- `web/src/react/state/shellStore.ts`：主题偏好持久化、系统主题监听、`resolvedTheme` 状态。
- `web/src/react/design/tokens.css`：全局 UI token 与旧的 shadcn 风格兼容变量。
- `AppearanceSection`：明暗模式、预设 accent 色和自定义 accent 色设置。
- `TerminalViewport`、`ThemeToggle`、菜单和布局组件：直接从 `shellStore` 读取主题状态。

主要问题：

1. 主题数据和 shell 业务状态耦合在同一个 store 中。
2. 主题文件没有稳定的外部契约，无法安全导入。
3. token 命名没有单一来源，存在 `--ui-*`、`--cx-accent-*`、旧兼容变量和局部硬编码色值并存。
4. CSS 组件与 JS 组件各自处理主题，无法保证一致性。
5. 导入失败、版本不兼容和部分配置缺失没有统一处理策略。

## 3. 设计原则

### 3.1 语义优先

组件只消费 `surface`、`text`、`border`、`accent`、`danger` 等语义 token，不消费主题文件中的具体 HEX 值。主题文件负责定义语义 token 的值，组件负责决定 token 的使用场景。

### 3.2 部分覆盖

主题文件允许只覆盖需要调整的 token。运行时先加载默认主题，再按主题文件覆盖，并按明暗模式分别合并。缺失 token 使用默认值，避免导入一个小主题文件导致界面出现未定义颜色。

### 3.3 运行时单向投影

主题状态是唯一事实来源，运行时只负责把规范化后的主题投影到 DOM CSS 变量和需要 JS 值的适配器。组件不反向修改 CSS 变量。

### 3.4 兼容优先

现有 localStorage 数据、旧变量名、旧设置入口和默认 accent 行为都保留兼容期。迁移完成后再删除旧实现，避免升级后出现主题闪烁或用户设置丢失。

### 3.5 配置文件可演进

主题文件带 `version` 字段。导入器必须拒绝未知主版本，并允许未来通过迁移函数处理旧版本格式。

## 4. 主题配置契约

新增主题契约模块，建议放置在 `web/src/lib/theme/`：

- `contract.ts`：公开类型、版本常量、token key 类型。
- `defaults.ts`：内置 Synax 默认主题。
- `schema.ts`：JSON schema/Zod 校验。
- `normalize.ts`：解析、校验、归一化、默认值合并和导出格式化。
- `runtime.ts`：DOM CSS 变量投影、系统主题解析、运行时订阅。
- `store.ts`：主题偏好和导入主题的 Zustand store。
- `io.ts`：文件读取、下载导出和导入错误转换。

主题配置的 v1 结构：

```ts
export interface SynaxTheme {
  version: 1;
  id: string;
  name: string;
  description?: string;
  colors?: {
    light?: Partial<ThemeColorTokens>;
    dark?: Partial<ThemeColorTokens>;
  };
  shape?: Partial<ThemeShapeTokens>;
  effects?: Partial<ThemeEffectTokens>;
}

export interface ThemeColorTokens {
  canvas: string;
  surface: string;
  surfaceSecondary: string;
  text: string;
  textMuted: string;
  textSubtle: string;
  border: string;
  borderStrong: string;
  accent: string;
  accentForeground: string;
  accentSoft: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  input: string;
  inputForeground: string;
  selection: string;
  focus: string;
  tooltip: string;
  tooltipForeground: string;
}

export interface ThemeShapeTokens {
  radiusSm: string;
  radiusMd: string;
  radiusLg: string;
  controlHeight: string;
}

export interface ThemeEffectTokens {
  controlShadow: string;
  insetShadow: string;
  floatingShadow: string;
}
```

实际 JSON 可以只包含部分 `colors.light` 或 `colors.dark` 字段，例如：

```json
{
  "version": 1,
  "id": "mist-blue",
  "name": "雾蓝",
  "colors": {
    "light": {
      "accent": "#98aecb",
      "focus": "#7897bd"
    },
    "dark": {
      "accent": "#98aecb",
      "focus": "#b3cbed"
    }
  }
}
```

`normalizeTheme()` 负责：

- 检查顶层对象、`version`、`id`、`name`。
- 规范化 HEX、RGB/HSL 等允许格式；v1 对外导出统一为 HEX 或 CSS 字符串。
- 拒绝脚本、函数、未知结构和超过长度限制的字段。
- 以默认主题为基底合并部分覆盖。
- 生成稳定的导出对象，避免把运行时计算字段写入文件。

## 5. 状态与持久化

新增独立主题 store，主题状态建议包括：

```ts
interface ThemeState {
  mode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  activeTheme: NormalizedTheme;
  source: "builtin" | "imported";
  importedTheme: NormalizedTheme | null;
  setMode(mode: ThemeMode): void;
  setTheme(theme: SynaxTheme): void;
  resetTheme(): void;
  setAccent(color: string): void;
  importTheme(file: File): Promise<ThemeImportResult>;
  exportTheme(): void;
}
```

持久化使用独立 key，例如 `synax-theme-preferences`，结构包含：

- `mode`
- `theme`：规范化主题或导入主题配置
- `source`
- `schemaVersion`

现有 `rumbling-shell-preferences` 中的 `theme` 和 `accentColor` 在首次加载时迁移：

1. 读取新 key。
2. 若不存在，读取旧 shell preferences。
3. 将旧 `accentColor` 转换为默认主题的 light/dark accent override。
4. 保存到新 key。
5. 保留旧字段读取一段兼容期，但后续写入只写新 key。

`ShellPreferences` 不再作为主题的事实来源；shell store 只保留非主题的用户偏好。涉及主题的组件统一从 `themeStore` 或 `useTheme()` 读取。

## 6. CSS 变量与组件解耦

规范化主题投影为稳定的 CSS 变量命名：

```css
--theme-canvas
--theme-surface
--theme-surface-secondary
--theme-text
--theme-text-muted
--theme-text-subtle
--theme-border
--theme-border-strong
--theme-accent
--theme-accent-foreground
--theme-accent-soft
--theme-success
--theme-warning
--theme-danger
--theme-info
--theme-input
--theme-input-foreground
--theme-selection
--theme-focus
--theme-tooltip
--theme-tooltip-foreground
--theme-radius-sm
--theme-radius-md
--theme-radius-lg
--theme-control-shadow
--theme-inset-shadow
--theme-floating-shadow
```

`tokens.css` 保留现有旧变量作为兼容别名，但其值全部来源于 `--theme-*`，而不是反过来。迁移后组件优先使用 `--theme-*` 或项目统一的语义别名。

JS/TS 组件不得自行拼接主题 HEX。需要颜色值的非 CSS 组件通过：

```ts
const { resolvedTheme, tokens } = useTheme();
```

或从纯函数 `getResolvedThemeTokens()` 读取。终端主题由同一套 token 生成，确保终端背景、前景、光标和选择色与应用一致。

## 7. 设置页与文件 IO

`AppearanceSection` 改为只负责展示和触发主题 action，不负责颜色计算或 localStorage 读写。

设置页包含：

1. 明暗模式选择：浅色、深色、跟随系统。
2. 当前主题信息：名称、内置/导入状态。
3. accent 预设和自定义颜色编辑器，写入当前主题的 accent override。
4. 导入主题按钮：选择 `.json` 文件，成功后即时应用。
5. 导出主题按钮：导出当前规范化主题。
6. 恢复默认主题按钮。
7. 实时预览区域继续使用语义 CSS token。

导入行为：

- 文件大小限制，建议不超过 256 KB。
- 读取失败、JSON 语法错误、schema 错误、版本不支持分别给出本地化提示。
- 导入成功前不修改当前主题。
- 成功后一次性替换主题状态并持久化。
- 主题加载时不重新加载页面。

导出行为：

- 只导出规范化后的可移植配置。
- 不包含用户本地路径、运行时状态或历史记录。
- 文件名使用 `<theme-id>.synax-theme.json`。

## 8. 迁移范围

第一阶段优先迁移以下路径：

- `web/src/lib/appearance.ts`
- `web/src/react/state/shellStore.ts`
- `web/src/react/design/tokens.css`
- `web/src/react/features/settings/components/AppearanceSection.tsx`
- `web/src/react/features/settings/components/appearance.css`
- `web/src/react/features/terminal/TerminalViewport.tsx`
- `web/src/react/components/ThemeToggle.tsx`
- `web/src/react/layouts/ActivityBar.tsx`
- `web/src/react/layouts/ProjectLayout.tsx`
- `web/src/lib/electron-menu.ts`

全局 `index.css` 不在第一阶段进行无差别重写，只替换与主题 token 直接相关的硬编码色值和兼容变量。组件级 CSS 按访问路径逐步迁移。

## 9. 错误处理与兼容策略

- 无效主题不覆盖当前主题。
- 未知主版本直接拒绝；未知的次级字段忽略并记录调试信息。
- 颜色无效时拒绝对应字段并回退默认值；若核心字段错误则整份文件拒绝。
- localStorage 不可用时主题仍可在内存中工作，页面重新加载后回退默认主题。
- 系统主题监听只影响 `mode=system`。
- 多窗口通过 storage event 同步，但只接受通过 schema 校验的 payload。
- 主题运行时在 SSR/测试环境下不直接访问 `window`，保持纯函数可测试。

## 10. 测试计划

### 单元测试

- 主题 schema 校验。
- HEX/CSS 颜色归一化。
- 部分主题与默认主题合并。
- light/dark token 选择。
- v0 旧偏好迁移。
- 无效导入保持当前主题不变。
- 导入/导出 round-trip。
- CSS 变量投影和旧变量别名。

### 组件测试

- AppearanceSection 的模式切换。
- 预设 accent 和自定义 accent。
- 导入成功、导入失败、恢复默认、导出触发。
- ThemeToggle 和系统菜单读取独立主题 store。
- 预览随着主题即时变化。

### 回归与视觉验证

- Web light/dark/system smoke。
- Electron light/dark smoke。
- 终端主题与应用主题同步。
- 1440、900、600、390 宽度下外观设置页截图回归。
- 检查 `--theme-*` token 未定义、无硬编码主题色回归。

## 11. 非目标

本次不包含：

- 用户账号云端同步主题。
- 主题市场或远程主题仓库。
- 动态加载第三方 JavaScript。
- 主题编辑器的完整设计工具能力。
- 全量重写所有历史 CSS。
- 改动业务功能和布局结构。

## 12. 验收标准

1. 内置默认主题在 light/dark/system 三种模式下视觉与当前版本一致或有明确的视觉改进。
2. UI 组件不再依赖具体 accent HEX 或 `appearance.ts` 内部计算实现。
3. 导入一个合法部分主题 JSON 后，颜色立即应用、刷新后仍然存在。
4. 导入非法或不兼容文件时，当前主题保持不变并显示错误提示。
5. 可以导出当前主题，并重新导入得到等价视觉结果。
6. 终端、菜单、设置页和主要工作区共享同一套主题运行时。
7. 现有主题偏好可以平滑迁移，用户无需重新设置。
8. 相关单元测试、组件测试和 Web/Electron smoke 通过。
