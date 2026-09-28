# Synax 设置内「MCP 服务器」与「电脑操作（含 Jev）」配置菜单

Status: approved（plan revision 1）
Date: 2026-09-28
Branch: `codex/mcp-computer-use-settings`

## 1. 背景与现状

MCP 与电脑操作能力已经落地，但都缺少界面配置入口：

- 电脑操作只有一张卡片，埋在「项目设置 → 常规」，没有独立菜单
  （`web/src/react/features/settings/ProjectSettingsPage.tsx:122`）。
- 卡片只渲染 `enabled` / `strategy` / `jev.enabled` / `jev.fallback`；契约里已有的
  `perception`、`jev.providerId`、`jev.model` 从未暴露
  （`web/src/react/features/settings/components/ComputerUseSettings.tsx:33-57`
  对 `api/services/computer-use/strategy.ts:2-8`）。
- Jev 密钥只能来自 API Sidecar 环境变量 `TYPESAFE_API_KEY`，界面无法配置
  （`api/services/computer-use/jev-tool-provider.ts:58-62`）。
- 侧栏「扩展 → MCP」打开的是扩展中心列表，不是 MCP 服务器配置
  （`web/src/react/features/settings/extensions/SettingsFrame.tsx:52-70`）。
- 已存在但**无人引用**的 `McpServersSection`（含测试），具备服务器增删改、
  参数与环境变量编辑、启用开关
  （`web/src/react/features/settings/components/McpServersSection.tsx:95`）。
- 全局 MCP 链路已通：`GlobalConfig.mcpServers`
  （`api/lib/config/config-types.ts:134`，web 侧 `web/src/lib/contracts/config.ts:133`），
  `PATCH /api/config/global` 的 zod 已支持该字段（`api/routes/config.ts:165`），
  落库经 `normalizeMcpServers`（`api/lib/config/config-store.ts:541`）。
- 密钥基础设施可复用：`encryptSecret` / `maskSecret`
  （`api/lib/config/config-secret.ts:17`、`:44`）。

## 2. 决策摘要（已与用户确认）

1. **菜单归属：全局设置**。新增两个独立菜单项；MCP 沿用全局
   `GlobalConfig.mcpServers`；项目设置的电脑操作卡片保留为项目级覆盖。
2. **Jev 密钥：加密存入全局配置**。写入用 `encryptSecret`，接口只回掩码；
   环境变量 `TYPESAFE_API_KEY` 保留为运维覆盖且**优先**。
3. **菜单结构：两个独立菜单项**「MCP 服务器」与「电脑操作」；原
   「扩展 → MCP」扩展中心入口保持不变。

## 3. 目标与非目标

目标：

- 全局设置出现「MCP 服务器」页，可增删改全局 MCP 服务器并持久化。
- 全局设置出现「电脑操作」页，可配置 `enabled` / `strategy` / `perception`
  与完整 Jev 配置（含密钥）。
- 密钥不以明文出现在任何 API 响应中。
- 项目未显式覆盖时，行为回落全局默认。

非目标：

- 不改扩展中心（「扩展 → MCP」）的行为与数据来源。
- 不改项目设置的菜单结构（仅调整卡片文案）。
- 不提供 Cua Driver 二进制路径、SHA-256 校验策略的界面配置。
- 不改 Jev 决策器与候选动作构造逻辑，不改变 `perception` 的运行时默认值。
- 本次不发版；如需发版按 `AGENTS.md` 执行 `npm run version:minor`。

## 4. 信息架构

- `SettingsSection` 联合类型（`web/src/react/features/settings/extensions/SettingsFrame.tsx:24`）新增 `'mcpServers' | 'computerUse'`。
- 侧栏在「扩展」分组之前新增分组「服务」（zh）/「Services」（en），放两个按钮：
  - 「MCP 服务器」→ section `mcpServers`
  - 「电脑操作」→ section `computerUse`
- 全局页（`GlobalSettingsPage.tsx:27`）：白名单加入这两个值并新增渲染分支。
- 项目页（`ProjectSettingsPage.tsx:60`）：白名单**不含**这两个值，且 `projectMode` 下 `SettingsFrame` 隐藏这两个入口，确保项目设置不出现全局项。
- 原「扩展 → MCP」保持不变；文案区分「MCP 服务器」（配置）与「MCP」（扩展中心）。
- URL 兼容：`?section=mcpServers` 与 `?section=computerUse` 可直接打开。

## 5. 数据模型与契约

后端 `GlobalConfig`（`api/lib/config/config-types.ts:123`）新增：

```ts
export interface GlobalComputerUseSettings {
  enabled?: boolean
  strategy?: 'auto' | 'direct' | 'jev'
  perception?: 'disabled' | 'auto' | 'required'
  jev?: {
    enabled?: boolean
    fallback?: 'direct' | 'fail_closed'
    providerId?: string | null
    model?: string | null
    apiKey?: string        // enc:v1: 密文
    apiKeyMasked?: string  // 对外展示
  }
}
```

- 默认值：`createDefaultGlobalConfig`（`api/lib/config/config-defaults.ts:97`）新增 `computerUse: { enabled: true, strategy: 'auto', perception: 'disabled' }`。
- 归一化：`config-store.ts` 读写时对 `computerUse` 做白名单归一（丢弃未知键），与既有 `normalizeMcpServers`（`config-store.ts:541`）同风格。
- 校验：`globalConfigPatchSchema`（`api/routes/config.ts:153`）新增 `computerUse` 子 schema 且保持 `.strict()`；`providerId`/`model` 长度 ≤ 512。
- 契约同步：web 侧 `web/src/lib/contracts/config.ts:122` 同步该字段。
- 策略语义：`api/services/computer-use/strategy.ts` 不改；新增纯函数 `mergeComputerUseSettings(global, project)` 产出最终设置（见 §10）。

## 6. 密钥与安全

- 写入：`encryptSecret`（`api/lib/config/config-secret.ts:17`），仓储内为 `enc:v1:…` 密文。
- 读取：响应只含 `apiKeyMasked`（`maskSecret`，`:44` 生成）；`apiKey` 字段即使为密文也不返回。
- 保存语义：请求体 `apiKey === undefined` 表示保持不变；`''` 表示清除。
- 运行时优先级：`process.env.TYPESAFE_API_KEY` → 配置库解密值 → 缺失（报错）。
- 日志：错误信息只说明「未配置」，任何路径都不打印密钥值。

## 7. 运行时联动

- 新增 `api/services/computer-use/jev-credentials.ts`：
  - `resolveJevCredentials(): { apiKey: string; source: 'env' | 'config' } | null`
  - `describeJevCredentialSource(): 'env' | 'config' | 'missing'`（供设置页显示来源，不返回密钥）
- `jev-tool-provider.ts:58-62` 改为调用它；无凭据时报错文案改为「Jev 已启用但未配置密钥：请在 设置 → 电脑操作 填写，或设置环境变量 TYPESAFE_API_KEY」。
- 生效时机：每次工具调用即时解析（不缓存密钥），保存后在下一个 `computer.use` 调用生效，无需重启。
- MCP 服务器保存后的生效沿用现网机制（会话级 MCP 连接缓存），本次不改变该语义。

## 8.「MCP 服务器」页

- 复用 `McpServersSection`（`components/McpServersSection.tsx:95`）：全局页传 `servers={globalConfig.mcpServers}`、`onUpdate={servers => updateGlobalConfig({ mcpServers: servers })}`。
- 可编辑字段：`id`、`name`、`command`、`args`、`env`、`cwd`、`enabled`，与 `api/routes/config.ts:165` 的 schema 对齐；若组件涉及的 `transport: 'http'` 字段不在该 schema 内，则以现有行为为准，不扩展 schema。
- 连接测试沿用 `POST /api/mcp/test`（`api/routes/mcp.ts:12`）。
- 页头使用既有 `SettingsCard` 风格，说明文字明确「此处配置对所有项目生效」。

## 9.「电脑操作」页

新增 `components/ComputerUseGlobalSettings.tsx`，三段：

1. **驱动状态与权限**：沿用 `getComputerUseStatus` 5 秒轮询与 `openComputerUsePermissions('accessibility'|'screen-recording')`；把 `ComputerUseSettings.tsx:35-39` 的逻辑抽成共享 hook `useComputerUseStatus`，两处复用。
2. **全局默认**：`enabled`、`strategy`、`perception` 三个控件，绑定全局 `computerUse`。
3. **Jev**：`enabled`、`fallback`、`providerId`、`model`、`apiKey`（`type=password`，回显掩码占位符，留空表示不修改）与「测试连接」按钮。
- 凭据来源提示：显示 `describeJevCredentialSource()` 的结果（环境变量 / 设置 / 未配置）。
- 保存走 `updateGlobalConfig`；失败就地提示，不静默降级、不自动回退到 Direct。

## 10. 项目级与全局级的合并语义（实现后修订）

- 现状：`getProjectSettings().computerUse` 总是返回默认值（`api/lib/config/project-settings-store.ts:214`、`:226`），存储层无法区分「未设置」与「显式设为默认值」。
- 最终采用的规则（字段级继承，见 `api/services/computer-use/strategy.ts` 的 `mergeComputerUseSettings`）：
  项目字段若**等于项目默认值**（enabled=true / strategy='auto' / perception='disabled'）则视为未覆盖，回落全局；一旦偏离默认值即视为显式覆盖。
- 已知限制：项目若想显式选择与默认相同的值（例如全局 perception='auto' 而项目要 'disabled'），当前模型无法表达。本轮不引入额外标记字段，保持存储向后兼容；如需该能力，后续可加显式 `inheritGlobal` 标记（原设计草案方案，已弃用）。
- 解析入口：`resolveComputerUseStrategy()` 保持纯函数；消费方（`jev-tool-provider.ts`、`mcp-session-tool-provider.ts`）改为调用 `resolveEffectiveComputerUseSettings(projectId)`（`api/services/computer-use/effective-settings.ts`），由它读取全局配置与项目设置后合并。
- 验证：`api/services/computer-use/effective-settings.test.ts` 覆盖未覆盖项目的全局回落、显式覆盖、部分覆盖三种情形。

## 11. 测试与验收

- 前端：`components/ComputerUseGlobalSettings.test.tsx`（字段渲染、密钥掩码、保存参数）、`GlobalSettingsPage.test.tsx`（两个新菜单项可切换、项目模式不渲染）、`McpServersSection` 全局挂载用例。
- 后端：config 路由测试（`computerUse` 校验、非法字段拒绝、响应只含掩码）、`jev-credentials.test.ts`（env 优先 / 解密回退 / 缺失报错）、合并语义测试（项目未覆盖时回落全局）。
- 命令：`npm run typecheck` + 定向 `npx vitest run <files>`。
- 基线：既有 11 项失败与 1 项桌面 smoke 断言失败为已知基线，验收以「数量不增加」为准。
- 真机验收：由用户在 Synax 桌面应用中目视确认菜单出现、保存与回显（密钥显示为掩码）。

## 12. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 全局页与项目页共享 `SettingsSection` 与 URL 白名单，漏改会让项目模式漏出全局入口 | 组件测试显式断言项目模式不渲染这两项 |
| `scripts/frontend-contract-boundary.test.ts` 要求 web/api 契约同步 | 同一提交内更新两侧契约 |
| 项目默认值填充掩盖「未覆盖」语义 | 引入 `inheritGlobal` 显式标记 + 兼容测试 |
| 密钥回显泄漏 | 路由测试断言响应不含 `apiKey` |
| 分支上存在他人未提交改动（`api/services/llm-runtime/retry.ts`、`abort-reason.ts`） | 提交时只 `git add` 本任务文件，不触碰他人工作 |

## 13. 交付物

- 本设计文档。
- 后端：`api/lib/config/config-types.ts`、`config-defaults.ts`、`config-store.ts`、`api/routes/config.ts`、`api/services/computer-use/jev-credentials.ts`、`jev-tool-provider.ts`、`strategy.ts`（仅新增合并函数）。
- 前端：`web/src/lib/contracts/config.ts`、`extensions/SettingsFrame.tsx`、`extensions/extension-copy.ts`、`GlobalSettingsPage.tsx`、`ProjectSettingsPage.tsx`、`components/ComputerUseGlobalSettings.tsx`、`components/ComputerUseSettings.tsx`。
- 测试：上述组件的 `.test.tsx` 与 `api/routes/__tests__`、`api/services/computer-use/jev-credentials.test.ts`。
- 分支 `codex/mcp-computer-use-settings`，`main` 保持不变。
