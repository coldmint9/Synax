# 会话暂停态设计

## 背景

Synax 会话目前没有"暂停"这个状态。用户主动停止（点停止按钮）和进程被强制退出（崩溃、被 kill、掉电后重启）在存储层都已经收敛到同一个会话状态 `interrupted`：

- 主动停止：`POST /sessions/:id/cancel` → `runCoordinator.interrupt` → `agentSessionRuntime.cancel` → `cancelOne` 把 run 置 `interrupted`、未完成 step 置 `cancelled`，会话置 `interrupted` 并清空 `activeRunId` / `pendingResumeToken`，同时写入 `manualStop` 元数据并发出 `resumable: true` 事件（`api/services/agent-runtime/session-runtime.ts:279`、`:302`、`:350`、`:362`）。
- 强制退出：进程重启后 `recoverRuntime` 把 run 置 `interrupted`、`finish_reason='server_restarted'`，把未决 permission 置 `deny`、未决 interaction 置 `cancelled`，会话置 `interrupted`、`activeRunId=null`（`api/services/agent-runtime/runtime-recovery.ts:190`、`:229`）。该函数只有一个调用点 `api/server.ts:169`，CLI 与 Electron 宿主都经过它。

问题在于"可继续"这个信息在投影层被丢掉，导致用户看不到、也用不上：

- 后端 `projectSessionState` 对 `synax` / `goal` profile 会把 `interrupted` 折成 `completed`（`api/services/agent-runtime/session-projection.ts:44`）。
- 前端 `patchAgentSession` 同样把 `cancelled` / `interrupted` 折成 `completed`（`web/src/react/features/agent-workspace/sessionComposerState.ts:19`）。
- 播放键的判定只认 `interrupted`（`web/src/react/features/agent-workspace/sessionComposerState.ts:95`）。

结果是：Synax 会话被停止或被强杀后，列表上显示为"正常完成"，播放键几乎不会出现，用户只能凭记忆重新发一句"继续"。

另外 `paused` 在历史上是**被主动废弃**的值：迁移 `api/db/migrations/0032_agent_session_status_simplification.sql` 把 `blocked` / `paused` 行改写为 `completed`，并在注释中声明 "AgentSession no longer models blocked/paused"。本次是重新建模 `paused`，理由与范围见下。

## 目标

- 新增一等会话状态 `paused`，语义唯一：**会话被暂停，可一键继续**。
- 用户主动停止会话 → `paused`。
- 进程被强制退出后重启恢复 → `paused`（现有的 `shutdownUnconfirmed` 分支除外）。
- 暂停态在会话列表、会话内输入区都提供播放键，一键继续会话。
- 保持 `run` / `step` 级的 `interrupted` 语义不变（工具调用被打断是另一回事）。

## 非目标

- 不删除或合并 run / step 级的 `interrupted`。
- 不改变 `waiting_permission` / `waiting_input` 的持久检查点语义（`isDurableRuntimeCheckpoint`，`api/services/agent-runtime/runtime-recovery.ts:23`）。
- 不改变 `runtimeControl.state='unconfirmed'` 分支（它表示"需要人工排查执行进程"，不是暂停）。
- 不重放被打断的 tool call，不引入 tool 幂等要求。
- 不改写历史迁移 `0032`，也不改写历史数据行。
- 不修改当前工作区中与本需求无关的未提交文件。

## 状态模型

### 会话状态枚举

`sessionStatusSchema` 增加 `"paused"`（`api/services/agent-runtime/contracts.ts:30`）。变更后枚举为：`stopping`、`queued`、`running`、`waiting_permission`、`waiting_input`、`paused`、`completed`、`failed`、`cancelled`、`interrupted`。

`interrupted` 保留在枚举中：强制退出以外的路径（如上下文压缩被中断）以及非 `synax` / `goal` profile 的既有行为不受影响。

### 投影层

- `normalizeAgentSessionStatus` 不再把 `paused` 折成 `completed`（`api/services/agent-runtime/session-projection.ts:19`）；`blocked` → `completed` 的遗留折叠保留。
- `projectSessionState` 对 `synax` / `goal` profile 增加 `paused` 直通分支（`api/services/agent-runtime/session-projection.ts:38`）。该函数末尾的 `completed` 兜底会吞掉任何未显式列出的状态，因此必须显式放行，否则 `paused` 在 wire 上不可见。
- 前端 `patchAgentSession` 对 `paused` 直通（`web/src/react/features/agent-workspace/sessionComposerState.ts:19`）。

## 后端行为

### 主动停止

`agentSessionRuntime.cancelOne` 写 `status: "paused"` 替代 `"interrupted"`（`api/services/agent-runtime/session-runtime.ts:350`）。其余字段保持不变：`completedAt: null`、`activeRunId: null`、`pendingResumeToken: null`、`resultSummary` 保留 "User stopped run."、`manualStop` 元数据保留、事件仍带 `resumable: true`。

`run` 与未完成 `step` 的落库状态不变（`interrupted` / `cancelled`），以保留"这一步确实被打断了"的事实。

### 进程强制退出恢复

`recoverRuntime` 在普通重启分支写 `status: "paused"` 替代 `"interrupted"`（`api/services/agent-runtime/runtime-recovery.ts:229`），`blockedReason` 继续保留现有原因文案（"The runtime restarted during execution…"）。

`shutdownUnconfirmed` 分支保持现状（`status: "completed"` + `runtimeControl.state='unconfirmed'`），因为它的含义是"执行进程状态未确认，需要排查"，与"可继续"互斥。

### 一键继续

继续复用已有通道，不新建机制：

- 会话状态白名单：`loop-runtime` 的 `RESUMABLE` 加 `"paused"`（`api/services/agent-runtime/loop-runtime.ts:224`）。
- 前端提交通道：`submitRun` 在状态属于 `{interrupted, cancelled, failed, completed}` 时走 `mode: "continue"`（`web/src/react/features/agent-workspace/state/agentSessionStore.ts:2353`），集合中加入 `"paused"`。

**继续的语义（假设 A1，见"待确认假设"）**：播放键等价于用户发一句"继续"，以 `mode: "continue"` 重新起跑一轮；被打断的 tool call 不重放，由模型基于已落库的上下文自行接着执行。

注意 `runCoordinator.resume` 不适用于暂停会话：它要求存在等待中的 pending run，否则返回 `NOT_RESUMABLE` 409（`api/services/agent-runtime/run-coordinator.ts:160`）。暂停会话的 run 已经是终态，因此播放键必须走 `continue` 提交路径。

### Goal 自动续跑

`goalContinuationInput` 要求 `session.status === 'completed'`（`api/services/agent-runtime/goal-continuation.ts:13`），因此暂停会话天然不会触发 goal 自动续跑，无需额外守卫。这一点需在实现时用测试固定下来，防止将来被改动。

## 前端交互

### 播放键

- 会话输入区：`isSessionResumable` 增加 `paused`（`web/src/react/features/agent-workspace/sessionComposerState.ts:95`），发送键位在暂停态显示为播放键，点击即继续。
- 会话列表行：暂停态行内提供播放键，允许不进会话直接一键继续。
- 暂停态下输入区仍可输入；携带输入内容继续时走既有"提交即续跑"分支（`web/src/react/features/agent-workspace/SessionComposer.tsx:780`）。

### 状态映射表

新增状态需要补齐下列位置，否则会出现漏色、误判已读、漏通知：

- 终态判定：`isTerminalSessionStatus`（`web/src/react/features/agent-workspace/state/agentSessionStore.ts:323`）、`patchSession` 内的 terminal 判定（同文件 `:2641`）、`COMPLETED_SESSION_STATUSES`（`web/src/react/features/agent-workspace/projectSessionBadges.ts:13`）。
- 状态色与图标：`SessionTreeItem.tsx:28`、`SessionQuickToolbar.tsx:14`、`SessionWorkspace.tsx:39`、`WorkspaceDashboard.tsx:135` 与 `:151`、`RunStepTimeline.tsx:26`。
- 文案：`runtimeProfileSummary.ts:37` 增加 `paused` 条目（中文"已暂停，可继续"/英文），i18n 词条同步（`web/src/lib/i18n.ts`）。
- 压缩按钮可用性列表（`web/src/react/features/agent-workspace/SessionComposer.tsx:686`）需决定暂停态是否允许压缩上下文；建议与 `completed` 一致（允许）。
- Goal 面板：`statusFor` 的暂停判定列表加入 `"paused"`（`web/src/react/features/agent-workspace/GoalMonitorPanel.tsx:47`），使真实 `paused` 状态映射到面板的 `paused`；面板"暂停"按钮现有实现即调用 `cancelSessionRun`（`:145`），改造后会自然写入 `paused`。

## 数据与迁移

新增迁移 `0033_agent_session_paused_status.sql`：

- 头部注释说明"会话重新建模 `paused`；`0032` 只影响历史行，不需要回滚"，避免后续读者再次按遗留值折叠。
- **不做数据改写**：`0032` 已把所有历史 `paused` / `blocked` 行改写为 `completed`，库中不存在语义冲突的残留值，重新启用不会与旧数据撞语义。
- `agent_runtime_sessions.status` 是无 CHECK 约束的 `TEXT`（`api/db/migrations/0006_agent_runtime.sql:12`），因此新状态值不需要表结构变更。

历史迁移测试 `api/db/__tests__/migrations.test.ts:66` 注入 legacy `paused` 行并断言其最终为 `completed`：该用例回放 ≤25 号迁移后由 `0032` 折叠，断言仍然成立，无需修改。

## 范围决策

- **子代理会话**：暂停态对子代理同样生效。需要把 `paused` 加入祖先校验的"祖先已停"集合（`api/services/agent-runtime/session-runtime.ts:69`），与 `interrupted` / `cancelled` 行为一致——祖先暂停时不允许创建新子代理。
- **Goal 模式**：Goal 面板现有"暂停/继续"按钮改为写入真实 `paused`，暂停态下不自动续跑（见上文验证点）。

## 待确认假设

以下两条的提问表单被运行时清空，按"推荐项"写入，评审时可推翻：

- **A1 继续的语义**：播放键 = 注入"继续"并新起一轮（不重放工具调用）。备选是"整轮重放"，需要工具幂等，不建议。
- **A2 范围**：子代理会话与 Goal 模式一并纳入暂停态。备选是只做主会话、Goal 面板维持现状（UI 文案层面的"暂停"）。

## 测试计划

- 单测：`cancelOne` 后会话为 `paused` 且 `activeRunId` 为 `null`；`recoverRuntime` 普通分支后会话为 `paused`、`shutdownUnconfirmed` 分支不受影响（扩展 `api/services/agent-runtime/__tests__/runtime-recovery.test.ts`、`runtime-crash-integration.test.ts`）。
- 契约测试：`sessionStatusSchema` 接受 `paused`；`projectSessionState` 对 `synax` / `goal` 输出 `paused` 而非 `completed`。
- 续跑测试：`paused` 会话以 `mode: "continue"` 提交成功；`paused` 会话不触发 `goalContinuationInput`。
- 前端：`isSessionResumable` 对 `paused` 返回 true；`patchAgentSession` 不再折叠 `paused`；终态/徽标判定把 `paused` 计入。
- 迁移：新增 `0033` 后 `migrations.test.ts` 全绿（验证历史行仍为 `completed`）。

## 回滚

改动集中在状态枚举、两个写入点、投影层与前端映射表。回滚即把两处写入点改回 `interrupted`，并在投影层恢复 `paused` → `completed` 折叠；期间产生的 `paused` 行会因折叠而显示为 `completed`，与 `0032` 的既有行为一致。

## 待实现时核实的项

- `run-admission` 的 `resume` 模式对 `paused` 会话是否需要在准入层放行（`api/services/agent-runtime/run-admission.ts:72`、`:121`）。
- CLI 的状态打印（`cli/main.ts:519`）与通知模块（`web/src/lib/notifications/sessionNotifications.ts`）是否需要为 `paused` 增加独立文案。
