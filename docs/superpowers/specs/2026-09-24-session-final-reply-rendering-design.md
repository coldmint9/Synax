# 会话终态回复可靠渲染设计

日期：2026-09-24

## 背景

Synax 的浏览器工作台和 Electron 桌面端共用 `web/src/react` 渲染器。当前会话回复通过 SSE live 事件进入 Zustand store，再由 `SessionStaticTimeline` 与 `BufferedMarkdown` 渲染；任务完成后通过 `refreshDetail()` 读取持久化 transcript。

现有逻辑在任务终态时已经尝试保留 live 内容，但保留和清理主要依赖 session 是否仍处于 active 状态。终态事件、最后一批 `message_delta`、消息持久化以及详情刷新之间存在竞态，可能发生以下顺序：

1. 最终文本已经在客户端 live buffer 中，但最终消息还未被详情接口读到。
2. `runtime_state(reset=true)` 或详情刷新开始，将 live 状态清理或用旧 transcript 覆盖。
3. session 已显示完成，页面没有可渲染的 assistant reply。
4. 刷新整个页面后重新读取数据库，回复才出现。

问题必须在共享 Web 状态层解决，不能分别为浏览器和 Electron 添加壳层补丁。

## 目标与非目标

### 目标

- 任务进入 `completed`、`failed`、`cancelled` 或 `interrupted` 后，在最终 transcript 尚未可见时继续显示最后一份 live 回复。
- 详情刷新返回旧数据、空数据或暂时失败时，不丢失 live 回复。
- 只有详情结果确认包含对应 run/step 的最终 assistant 内容后，才清理终态快照。
- 确认持久化后，live 快照与正式 transcript 不重复显示。
- 保持浏览器和 Electron 使用相同的状态逻辑。
- 保留现有流式 Markdown 的渐进显示行为；终态快照不再被流式缓冲计时器阻塞。

### 非目标

- 不重写 Markdown parser 或 Markdown 样式。
- 不改变服务端消息持久化协议和 SSE 事件协议。
- 不改变 session archive、fork、rollback 或历史分页语义。
- 不为 Electron 增加独立的渲染状态实现。

## 设计

### 1. 终态快照成为显式的过渡状态

沿用 `streamingCompletedSteps` 作为最终 live 快照容器，但把其语义明确为“尚未被详情确认的流式 step 快照”，而不是只表示下一 step 开始前的中间内容。

收到终态 `runtime_state` 时：

1. 先强制刷新尚未提交的 delta batch。
2. 对当前 `streamingLive` 调用 `snapshotStreamingBuffers()`，将 pending text、thinking 和 tool calls 物化为完整 blocks。
3. 将快照追加到 `streamingCompletedSteps`，记录真实的 `stepId` 和可关联的 `runId`（如当前状态已有该信息，则一并保存）。
4. 保留 `streamingStepId` 和快照，清理 retry 状态，但不清空可见内容。
5. 触发详情刷新。

如果终态到达时当前 step 没有内容，则不创建空快照；已有的 completed snapshots 仍然保留，直到逐项确认。

### 2. 详情刷新按内容确认，而不是按 session 状态清理

详情 transcript 应同时更新普通状态和快照确认结果。对每个终态快照执行以下确认：

- 优先按 `stepId` 匹配详情中的 step，并检查该 step 关联的 assistant message 是否存在且内容非空。
- 如果消息没有 stepId，则按快照的 runId 匹配 message.runId。
- 仅有 completed step、run completed 或 session completed 状态不算确认，因为这些结果可能早于最终消息写入。
- 详情请求失败、返回空消息、返回旧消息，均视为未确认。

确认成功后：

- 从 `streamingCompletedSteps` 移除对应快照。
- 如果当前没有未确认的快照和 live step，再清空 `streamingStepId`、`streamingLive` 和 retry 状态。
- 正式 transcript 负责最终渲染，避免重复。

未确认时：

- 更新 runs、steps、messages 等详情字段，但保留对应 live 快照。
- 不允许旧详情结果把 live 状态重置为空。
- 若详情结果包含同一 step 的部分信息但 assistant 内容为空，仍保留快照。

### 3. 终态快照按完成内容渲染

终态快照应作为 completed step 传给 `SessionStaticTimeline`，并以 `isStreaming=false` 渲染：

- Markdown 内容立即交给 `BufferedMarkdown` 的非流式路径。
- 不等待下一次换行、interval tick 或 work-log collapse delay 才显示最终内容。
- 在正式 transcript 确认前，快照是唯一可见来源；确认后由 transcript 接管。

当前正在运行的 step 继续使用 `streamingLive` 和现有的流式 Markdown 路径，不改变正常增量渲染。

### 4. 详情刷新与重试

终态触发的详情刷新应具有有限的确认重试：

- 首次刷新使用现有刷新调度，避免每个事件重复请求。
- 如果返回结果未确认快照，安排短延迟的再次刷新。
- 设置最大重试次数或最大确认窗口，避免异常 API 永久轮询。
- 在确认窗口结束后仍保留快照并显示当前结果，同时记录可诊断状态；下一次用户打开会话或手动刷新时继续收敛。

重试必须遵循现有的 session/project/refresh epoch 检查，不能将旧会话结果写入新选中的会话。

### 5. 与历史缓存的关系

- 终态快照不写入 `sessionDetailCache`，因为它不是服务端权威 transcript。
- 详情返回后，正式 transcript 仍按现有 history merge 逻辑更新。
- 只有确认对应快照后，才允许把快照从内存 live 状态移除。
- 切换 session、删除 session、重置会话历史时，按现有生命周期一次性丢弃当前会话快照。

## 数据流

```text
SSE message_delta
  -> delta batch
  -> streamingLive
  -> running step + BufferedMarkdown(isStreaming=true)

SSE runtime_state(reset=true, terminal)
  -> flush delta batch
  -> snapshotStreamingBuffers
  -> streamingCompletedSteps[step]
  -> refreshDetail()
  -> completed snapshot remains visible

refreshDetail transcript
  -> update runs/steps/messages/cache
  -> match step/run + non-empty assistant message
      -> confirmed: remove snapshot, transcript owns rendering
      -> unconfirmed: keep snapshot, schedule bounded retry
```

## 错误处理

- 详情接口网络错误：保留终态快照，设置已有的 detail error，不清除用户可见回复。
- 详情接口返回旧数据：视为未确认，保留快照并进行有限重试。
- session 已被删除：沿用现有资源清理逻辑，同时清理该 session 的 live 状态。
- SSE 重连收到旧 snapshot：事件按 stepId/sessionId 去重和隔离，不能覆盖当前未确认快照。
- 收到旧 step 的迟到 delta：继续沿用现有 stepId 校验，忽略迟到事件。

## 测试设计

### Store 单元测试

新增或扩展 `agentSessionStreaming` 测试：

1. `runtime_state` 终态到达后，最后文本被物化到 `streamingCompletedSteps`，不会被清空。
2. 详情刷新返回没有最终 assistant 内容时，快照仍保留。
3. 详情刷新返回匹配 step 的最终 assistant 内容后，快照被清理。
4. 旧详情刷新不能覆盖较新的终态快照。
5. 多个 completed snapshots 逐项确认时，只清理已确认项。
6. 终态前最后一批 delta 与终态事件连续到达时，文本不丢失。

### 渲染测试

扩展 `SessionStaticTimeline.finalSummaryStreaming.test.tsx`：

- 任务结束但 transcript 尚未确认时，最终 Markdown 立即可见。
- 快照确认并切换到正式消息后，内容只出现一次，stream tail 消失。
- 不需要刷新页面，也不需要等待额外换行即可看到最终段落。

### 验证命令

```bash
npm run --prefix web test -- --run web/src/react/features/agent-workspace/state/__tests__/agentSessionStreaming.test.ts
npm run --prefix web test -- --run web/src/react/features/agent-workspace/__tests__/SessionStaticTimeline.finalSummaryStreaming.test.tsx
npm run typecheck
```

如仓库当前 Vitest 脚本参数不接受上述形式，则使用等价的 `npx vitest run <file>` 命令，并记录实际执行结果。

## 实施边界

预计修改：

- `web/src/react/features/agent-workspace/state/agentSessionStore.ts`
- `web/src/react/features/agent-workspace/__tests__/` 或 `state/__tests__/`
- 必要时修改 `SessionStaticTimeline.tsx` 或 `SessionLiveTurn.tsx` 的快照渲染契约

不修改：

- Electron 主进程生命周期代码
- API SSE 协议
- Markdown parser 和样式系统
- 当前用户工作区中的无关未提交修改
