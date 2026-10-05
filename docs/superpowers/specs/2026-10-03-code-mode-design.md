# Synax 1.7.x Code Mode

已于对话中批准，2026-10-03 按「直接实施」执行。生产基线：main / 3ba78f03。

## 范围与取舍

1.7.0 提供轻量、无状态、只读 JavaScript 编排，Direct Tool Calling 不被替换。
使用 QuickJS WASM（固定依赖版本）隔离用户代码，独立 worker thread 提供硬取消；worker 本身不是安全边界，QuickJS 不注入 Node、FS、网络、环境变量或模块加载器。不使用 Node vm / eval 执行模型代码，不引入容器或 durable workflow。

复用现有 RegisteredTool、ToolRegistry.execute、权限检查、项目设置、工具事件和结果展示。工具入口为 code.tools（按需目录/Schema）和 code.run（async function body）。脚本用 `await tools.call("file.read", {path:"README.md"})`，最终 `return` JSON 值，console.log 仅作有界诊断。

## 权限和数据边界

- 项目配置 `codeMode.enabled` 默认 false，`mcpTools` 默认空；环境 `SYNAX_CODE_MODE=0` 总关闭。仍受 profile、workflow、项目工具启停策略约束。
- 本地只允许实际存在的 file.read / file.list / rg / diff.read / context.read，不增加旧规划里已删除的 Wiki、file.glob 或 grep 工具。
- MCP 必须同时：明确只读、项目管理员逐工具 allowlist、会话已挂载。MCP readOnlyHint 不是可信安全证明，管理员应验证服务器行为。内置 CUA 不加入 allowlist。
- tools.call 每次重新检查配置、挂载和权限。工具执行复用 Registry；需要 ask 的内部请求记为 denied，不产生 pending permission，不自动恢复/重放，不继承外层审批授权。
- 每个内部调用持久化为 ToolCallRecord，通过保留的内部 modelToolCallId 前缀关联父调用；模型上下文投影过滤内部调用，只接收外层聚合结果。保留原始审计以便用户排查。
- 输出、日志、入参、调用次数、并发、内存、运行时间有固定上限；模型不能提高配额。取消透传并终止 worker。已在远端执行的只读请求不能保证服务端撤回。
- 每次运行新 runtime/context，无 REPL、任意依赖、直接 I/O、后台任务或跨运行变量。

## 生命周期和错误

外层沿用 tool_call/tool_result；内部同样沿用事件并标记 parentToolCallId，不复制事件体系。失败返回 failed/timed_out/cancelled/denied/unavailable 及下一步指引。模型可以决定改用原生工具，但 Harness 不自动重跑整段代码，也不替用户审批。

上下文和执行器资源有限制，不把无限输出先 dump 到 Node 再截断；JSON 序列化在 QuickJS 内执行，有界 JSON 跨边界。执行器启动错误 fail closed。生产构建包含独立 worker entry 和内嵌 WASM，无运行时下载。

## 发布边界

1.7.0 交付整个可用只读纵切（执行、发现、MCP、权限、观测、项目开关、验证）；1.7.1+ 仅修复和兼容性/性能优化。新增副作用功能遵循 minor 规则到 1.8.0，不用 patch 承载新功能。版本唯一源 .env.version，通过 version:minor/sync 更新。

## 不做

写文件、Shell、发布/发送、浏览器/CUA、子代理、媒体生成、审批 continuation、幂等重放、工作流编辑器、自动保存代码为任务。现有直接工具保留以上能力及其审批路径。

## 验收

真实 WASM 执行及打包 worker 冒烟；隔离/无限循环/内存/输出/调用配额/取消测试；实际 Registry + MCP 集成权限测试；模型历史不泄漏中间结果；项目默认关闭；类型检查、核心回归和构建。记录任何既有失败，不把未测的真实模型收益或平台兼容标记为通过。
