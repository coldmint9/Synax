# Synax 1.7.0 Code Mode

## 启用与使用

项目设置 → 项目设置（general）→ Code Mode，开启并保存。默认关闭，不改变旧项目/会话的直接工具行为。
适用于原生 Synax backend，并且 profile 仍须允许 code.run/code.tools（主 Synax profile 可用，受限 explorer/specialist 不自动扩权）。
运维环境变量 `SYNAX_CODE_MODE=0` 可总关闭；项目禁用后不再允许新的内部调用，已发到远端的只读请求不能保证撤回。

模型先调用：

```json
{"query":"file"}
```

工具名为 `code.tools`。返回最多 8 条目录和 nextOffset；传 `{"toolId":"file.read"}` 获取单个输入 Schema。
然后调用 `code.run`，code 字段是一段 **JavaScript async 函数体**，不是 TypeScript/module，也不需要自行包裹函数：

```js
const files = await Promise.all([
  tools.call("file.read", {path: "README.md"}),
  tools.call("file.read", {path: "package.json"})
]);
return files.map(file => ({
  path: file.path,
  characters: file.content.length,
  truncated: file.truncated
}));
```

仅支持有界 JSON 入参/结果；undefined 的最终返回归一为 null。BigInt、循环对象等不能跨边界。
可用 console.log/warn/error 作少量诊断。没有 Node process/require、fetch、宿主 FS、模块加载器、跨执行变量或后台任务。
内置集合为 file.read、file.list、rg、diff.read、context.read；仍须该工具在当前会话挂载且权限允许。

## MCP

在同一个设置卡片中每行添加一个**完整运行时工具 ID**，例如 `mcp.docs.search`。
必须同时满足：项目配置该 server 且启用；session/turn 已选择该 server；server 明确返回布尔 readOnlyHint=true；管理员逐工具 allowlist；当前 profile/原有权限允许。内置 CUA 排除。

**白名单不是授权绕过。** 初次工具审批或读取越界路径时，Code Mode 内调返回 denied，不创建等待审批状态；模型应改用原生工具请求审批，获批后再决定是否重新运行。程序不会自动重试、恢复或重放。
项目级工具授权撤销、工具禁用、项目开关变化都在后续内调重新检查。

**信任边界：** readOnlyHint 是服务器声明，不是行为证明。管理员必须核实服务器只读实现。获准的 MCP 请求仍会把代码组装的参数发给外部服务器；这不是数据防泄漏平台，也不自动防御工具返回内容的提示注入。

## 固定限制

| 项目 | 上限 |
| --- | --- |
| 每次总时长（含 worker 启动、工具等待） | 15 秒 |
| QuickJS guest heap | 32 MiB |
| 源代码 / 单次工具入参 | 各 32,000 UTF-8 bytes |
| 每次内部调用数 / 同时在途调用 | 32 / 4 |
| 单个工具 JSON 结果进入 guest | 256,000 bytes |
| 最终值 / 日志 | 16,000 / 4,000 bytes |
| 每个 agent 进程同时执行器 | 2 |

32 MiB 仅限制 guest heap，宿主工具及 MCP transport 的资源消耗仍受各自已有实现约束；不是整个进程/远端服务器的总内存上限。

越限返回明确失败，不静默改变查询语义。日志允许截断并标记 truncated；最终值过大则要求缩小摘要。
模型历史沿用现有 4,000 字符工具输出预算，可能进一步截断；聚合值优先，诊断日志最多投影 1,000 字符。完整输出和 nestedCalls 留在普通工具审计记录中。

## 架构与取舍

- QuickJS 0.32.0 单文件 WASM 位于独立 worker。WASM interpreter 是能力隔离层；worker 提供硬终止和生命周期，不把 Node Worker 本身称为安全沙箱。
- Host bridge 唯一外部能力是 tools.call，每次进入既有 ToolRegistry.execute；不复制权限框架。
- 内调移除外层临时 sandbox approval，不继承 code.run 的用户授权。
- 沿用 tool_call/tool_result 和 ToolCallRecord；内部 modelToolCallId 使用保留的 `__synax_code__:<parent>:<sequence>` 关联父调用，事件携带 parentToolCallId。无新增审计表/数据库迁移。
- 内部原始结果从模型请求、历史投影、循环提示、去重索引中排除，但保留文件读写追踪及用户审计。
- code.run/code.tools 不走普通只读工具结果去重，避免动态目录/权限变化后返回过时结果。
- 结构化逻辑失败可保留 outputRef，同时持久化 failed/denied 状态；取消透传到内调，远端不合作时终止本地等待，不声称撤销远端请求。
- 单次无状态；进程崩溃后不恢复 JS 堆、不自动重新执行脚本。写操作、Shell、长期工作流和可恢复审批不属于 1.7.0。
- **保留原有 Direct Tool schemas。** code.tools 是 Code Mode 的按需目录，不改变已有 mountAllTools 策略，1.7.0 不宣称节省顶层工具定义 tokens。此版主要消除多次模型编排往返和中间结果上下文；真实模型任务收益需另行基准测试。

## 工程入口

- `services/local-node/modules/agent-runtime/code-mode/`：合约、策略、发现/桥接、worker、父侧执行器。
- `services/local-node/modules/agent-runtime/tool-registry.ts`：注册、权限拒绝、嵌套事件、可取消等待。
- `client/src/features/settings/components/CodeModeSettings.tsx`：项目开关与精确 MCP allowlist。
- `server-dist/workers/code-mode.cjs`：生产自包含产物，无运行时下载。

```sh
npm run test:code-mode
npm run --prefix client test -- src/features/settings/components/CodeModeSettings.test.tsx
npm run typecheck
npm run typecheck:cli
npm run build
npm run test:code-mode:bundle
npm run client:build
```

## 本次验证记录

- Code Mode 单元/真实 Registry/MCP HTTP：21 项通过。
- 加上完整 loop-runtime、loop-model-messages、permission-policy、tool-registry 重点回归：92 项通过。
- 前端设置组件：4 项通过。
- 后端/CLI 类型检查、后端构建、客户端构建通过；客户端仍提示现有大 chunk 警告。
- 生产 bundle 实测：嵌入 WASM、双路异步 RPC、无 Node globals，通过。
- Chromium 实际页面 + 独立 DATA_ROOT/API：默认关闭 → 无效输入 → 保存开启 → 刷新持久化 → 关闭刷新，通过；1365px 与 390px 截图检查，控制台无 pageerror，Code Mode 面板无横向溢出。
- 最终全量 `npm test`：313 files passed / 10 failed；2419 tests passed / 14 failed / 1 skipped。14 个失败用例均在生产基线 `3ba78f03` 导出的独立目录上复现，不属于本次新增回归；分类和处置见 `code-mode-baseline-failures.md`。
- 基线失败涉及 checkpoint-files/recovery、context-epochs、run-coordinator、session-capabilities/runtime/store-query、subagent-controls、visualization-integration、runtime-http-lifecycle。
- 未验证：Windows/Linux/Electron 安装包实机、真实付费模型 token/延迟收益、第三方安全审计。不得将以上构建/单测替代这些验证。

正式发版前仍需处理或明确接受基线失败、补平台验收，并按 main 发布规则汇总相对上一个 Tag 的全部变更。本次不推送 main、不打版本 Tag。
