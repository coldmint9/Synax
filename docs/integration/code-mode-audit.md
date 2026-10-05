# Code Mode 专项审查记录

日期：2026-10-04
分支：`feature/1.7.0-codemode`
实现提交：`43bf67d3`
审查范围：`services/local-node/modules/agent-runtime/code-mode/`、ToolRegistry 桥接、MCP 适配、上下文投影、项目设置。

## 结论

当前 Code Mode 仍符合 1.7.0 的「默认关闭、只读编排、无自动审批/重放」边界；未发现能绕过现有 ToolRegistry 权限或直接获得 Node 主机能力的路径。没有因 Code Mode 新增的失败用例：当前全量失败的 14 项在生产基线 `3ba78f03` 上全部复现，详见 `code-mode-baseline-failures.md`。

本结论不是第三方安全审计，也不代表已完成 Windows/Linux/Electron 安装包或真实模型评测。

## 检查项

| 边界 | 证据 | 结论 |
| --- | --- | --- |
| Guest 执行 | QuickJS 0.32.0 单文件 WASM，独立 Worker；生产 bundle 冒烟通过 | 不执行 Node `eval`/`vm`，worker 退出释放 guest runtime |
| 主机能力 | worker 只接受 `tools.call` RPC；未注入 Node、FS、网络、环境变量或模块加载器 | 通过 |
| 代码逃逸 | executor 测试覆盖 `process`、`require`、`fetch`、`WebAssembly` 和 constructor escape | 通过 |
| 时间/内存/输出 | 15s、32MiB guest heap、代码/参数/结果/日志/调用/并发上限；超限失败 | 通过；32MiB 不等同于宿主或远端总内存上限 |
| 取消 | AbortSignal → executor controller → nested ToolRegistry call；不合作的远端只读请求不阻塞本地返回 | 通过；不声称撤回已发出的远端请求 |
| 工具授权 | 每次内调重新检查项目开关、工具挂载、Profile、mutability、MCP allowlist 和 ToolRegistry 权限 | 通过 |
| 审批边界 | 内调 `ask` 转为 denied，不创建 waiting_permission，也不继承外层 sandbox approval | 通过 |
| MCP | 必须项目逐项 allowlist + 当前 session 挂载 + server `readOnlyHint === true`；CUA 排除 | 通过；readOnlyHint 是服务器声明，不是行为证明 |
| 审计 | nested `ToolCallRecord` 使用 `__synax_code__:<parent>:<seq>` 关联；事件携带 parent；原始结果留审计 | 通过 |
| 模型上下文 | nested records 从 loop history、dedup、doom-loop、context projection 过滤；外层 code.run 只投影聚合结果 | 通过；完整原始结果不进入模型上下文 |
| 重放 | 每次新 worker/新 QuickJS context；无 REPL、持久变量、后台任务或自动 replay | 通过 |
| 写入副作用 | Code Mode eligible 集合只含本地只读工具和 allowlisted read-only MCP；写、Shell、浏览器、子代理不进入集合 | 通过 |
| 全局关闭 | `SYNAX_CODE_MODE=0` 在项目和执行策略两层关闭 | 通过 |

## 已确认并接受的限制

1. **MCP 的只读标记不可信。** 第三方服务器可以错误或恶意声明 `readOnlyHint`；设置文案要求管理员验证服务器行为。1.7.0 不把 MCP 当作安全隔离边界。
2. **远端请求不可撤回。** 本地取消会停止等待、终止 worker 并向工具透传 signal；服务器若忽略 signal，已经发送的请求无法由 Synax 撤回。1.7.0 只允许只读语义工具，写操作不纳入 Code Mode。
3. **宿主资源和远端资源另有配额。** QuickJS 32MiB 只限制 guest heap；ToolRegistry、MCP transport、文件系统和远端服务继续受各自限制。
4. **Direct Tool Schema 未缩减。** 这一版没有宣称解决顶层工具定义 token 膨胀；Code Mode 主要减少多轮编排和中间结果回传。

## 未发现的风险

- 未发现从 Code Mode 直接加载 Node module、读取环境变量、访问网络或任意宿主文件的路径。
- 未发现通过外层一次/始终允许授权绕过 nested call no-prompt 策略的路径。
- 未发现 nested call 进入模型历史后会泄漏原始文件/MCP 内容的路径。
- 未发现代码运行失败会自动重跑整个脚本或重复执行已完成只读调用的路径。

## 发布前仍需

- 在目标 Electron 安装包中验证 worker/WASM 资源和退出清理。
- 在 Windows/Linux 目标环境运行隔离、取消、路径和安装包测试。
- 用真实模型跑固定任务集，测正确率、往返、耗时、token 和失败率。
- 对 MCP allowlist 的产品信任模型做安全评审。
- 先处理或明确接受 `code-mode-baseline-failures.md` 中的 release-blocker。
