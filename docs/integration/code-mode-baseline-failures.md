# 1.7.0 基线失败分类与处置

日期：2026-10-04
基线：`3ba78f03`（从远端 `main` 拉取的生产 HEAD）
当前结果：313 个测试文件中 10 个文件失败；2419 通过、14 失败、1 跳过。
基线复现：同一组 14 个失败在独立导出的 `3ba78f03` 工作目录复现。

## 分类总览

| 类别 | 数量 | 用例 | 处置 |
| --- | ---: | --- | --- |
| 生命周期/停止语义 | 5 | `run-coordinator` 1、`subagent-controls` 3、`runtime-http-lifecycle` 1 | **Release blocker**：统一 paused/interrupted/completed 的状态机语义，并补端到端回归 |
| Checkpoint/资源与并发 | 2 | `checkpoint-files` 1、`checkpoint-recovery` 1 | **Release blocker**：修正测试预算/产品预算契约，定位同路径写入 fence 超时/死锁 |
| Context 投影契约 | 1 | `context-epochs` 1 | **Release blocker**：确认 system-reminder/epoch 归属，再修实现或断言；不能通过放宽 token 预算掩盖 |
| 删除后访问语义 | 1 | `session-runtime` 1 | **Release blocker**：明确删除后 API 是返回空集合还是 not-found，并让所有 list/get 方法一致 |
| SQL 查询测试契约 | 2 | `session-store-query` 2 | **Baseline test debt**：实现已有 archived/deletion 过滤和 CTE 查询；测试仍按旧 SQL 形状/查询次数断言，需改为语义断言后再发布 |
| Profile/Skill 能力契约 | 3 | `session-capabilities` 2、`visualization-integration` 1 | **Baseline test/fixture debt**：旧测试仍期待 `edit`、旧 skill 候选/唯一 skill；需对齐当前 Profile/Skill 注册事实，不由 Code Mode 扩权 |

## 逐项记录

### 1. `checkpoint-files.test.ts`

- **症状：** 大文件 before-image 被 `resource-admission.ts` 以 `VERSION_DISK_BUDGET` 拒绝。
- **根因分类：** 测试构造的文件规模超过当前受控历史写入预算；不是 Code Mode 代码路径。
- **处置：** 检查产品是否仍需支持该规模；若需支持，扩大/分级预算并保留磁盘保护；否则将测试改为显式验证预算拒绝，另加不超预算的 streaming 测试。
- **级别：** Release blocker。

### 2. `checkpoint-recovery.test.ts`

- **症状：** 不同路径并行、同路径串行的 recovery 测试在 5 秒内未完成。
- **根因分类：** checkpoint 文件锁/fence 的并发等待没有在测试场景收敛，疑似锁释放或恢复路径时序问题。
- **处置：** 以锁 key、owner、release 和 abort 事件做诊断；禁止简单提高测试 timeout 掩盖死锁。
- **级别：** Release blocker。

### 3. `context-epochs.test.ts`

- **症状：** 预期保留 6 条消息，实际多出带 `state-9` 的 system reminder 和决策内容。
- **根因分类：** context epoch 投影边界与测试 fixture 的 reminder 归属不一致。
- **处置：** 确认 reminder 是否属于应保留的必需上下文；修 projection 或精确更新 expected，不放宽整体窗口。
- **级别：** Release blocker。

### 4–7. `run-coordinator.test.ts`、`subagent-controls.test.ts`（4 项）

- **症状：** 停止子会话/后代后实际状态为 `paused`，测试和输出契约期待 `interrupted`；`subagent.delegate` 输出也带 `childStatus: paused`。
- **根因分类：** 暂停功能引入后的状态机语义没有在 RunCoordinator、SessionRuntime、HTTP 输出和测试间统一。
- **处置：** 定义终态转换表：用户主动停止、暂停、取消、父级停止分别对应什么状态；统一持久化、快照和 tool output，再补 root/child/sibling/queued/waiting cases。
- **级别：** Release blocker。

### 8. `session-runtime.test.ts`

- **症状：** 删除 session tree 后，旧 `listMessages(sessionId)` 直接抛 not-found，而测试期待空集合。
- **根因分类：** 删除后读取 API 契约不一致；`getSession` 先行校验，而部分 list API 仍可能按空结果语义工作。
- **处置：** 选择并记录一种公共语义；建议资源型 `get` 返回 not-found，删除审计/列表查询使用显式 empty helper，不让每个方法隐式猜测。
- **级别：** Release blocker。

### 9–10. `session-store-query.test.ts`

- **症状：** SQL 现在先包含 `archived_at IS NULL` 和 `conversation_v3_deletions` 过滤；树查询包含 session 校验/CTE 之外的观测查询，旧断言期待固定 `WHERE` 开头和单条 SQL。
- **根因分类：** 实现已经增加归档/删除可见性保护，测试仍绑定旧 SQL 字符串形状和调用次数。
- **处置：** 保留 SQL 过滤；测试断言关键条件、参数和结果，不断言脆弱的 SQL 起始位置/总查询数；若要求单查询，应把校验合并为 API 内部的明确方案。
- **级别：** Baseline test debt，发布前应更新。

### 11–12. `session-capabilities.test.ts`

- **症状：** explorer 候选 skill 包含当前项目/平台 skills，不再只有旧内置 skill；executor 不再暴露旧 `edit` ID。
- **根因分类：** Skill 注册和工具命名已经迁移，测试仍按旧 inventory 断言；与 Code Mode 无关。
- **处置：** 以当前 `skillAgentBridge` 和 `toolRegistry.listForSession` 的实际公开契约重写测试，不能为了旧测试重新挂载已移除的 `edit`。
- **级别：** Baseline test/fixture debt。

### 13. `visualization-integration.test.ts`

- **症状：** 测试期待 `synax-builtin/visualize`，当前 Skill registry 未发现该旧 skill。
- **根因分类：** 可视化能力迁移/skill bundle 变更后的旧测试契约。
- **处置：** 确认新视觉能力入口；若已由现有 `visualize` 工具/manifest 替代，更新测试，否则恢复明确的内置 skill 注册。
- **级别：** Baseline test/fixture debt。

### 14. `runtime-http-lifecycle.test.ts`

- **症状：** shutdown 确认后快照状态仍为 `paused`，测试期待 `completed`。
- **根因分类：** 停止/暂停/正常完成的 HTTP 生命周期语义混用，与 Code Mode 无关。
- **处置：** 和 `run-coordinator`、`subagent-controls` 合并处理，先定义状态机再改 HTTP 快照契约。
- **级别：** Release blocker。

## 与 Code Mode 的隔离结论

- 14 项失败在 `3ba78f03` 基线全部存在。
- 失败文件不包含 Code Mode 新增执行器、策略或设置测试。
- Code Mode 重点回归仍为 92 项通过；生产 worker、真实 MCP HTTP 和浏览器设置流程均已单独验证。
- 因此本轮不修改上述历史子系统，避免把 Code Mode 分支变成无边界的运行时重构；这些项目应作为独立发布门禁工作项处理。
