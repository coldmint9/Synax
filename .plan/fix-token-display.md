# 修改计划: Token 统计只展示当前上下文大小

## 问题

前端 `SessionStatusCard` 显示 `127.0K / 200K tokens`，其中 127.0K = `latestInputTokens + cumulativeOutput`。
`cumulativeOutput` 是所有步骤的 output 累加，包含了压缩前的历史输出 token，不反映当前上下文实际大小。

而进度条 34% = `latestInputTokens / 200K`，只看最后一步的 input（即当前上下文窗口真实占用），两者语义矛盾。

## 目标

让数字显示和进度条一致：都表示"当前上下文窗口的实际 token 占用量"。

## 修改方案

### 1. API 层 — `session-store.ts` (getSessionStats)

将 `tokenUsage.total` 改为只反映当前上下文大小（= `latestInputTokens`），不再累加历史 output。

```diff
- const total = input + output;
+ const total = input; // 当前上下文实际占用
```

同时保留 `output` 字段（累计输出）供其他地方参考，但 `total` 的语义变为"当前上下文大小"。

### 2. 前端 — `SessionWorkspace.tsx` (SessionStatusCard)

更新显示文案，让数字含义更清晰：

```diff
- {(stats.tokenUsage.total / 1000).toFixed(1)}K / {(stats.contextLimit / 1000).toFixed(0)}K tokens
+ {(stats.tokenUsage.total / 1000).toFixed(1)}K / {(stats.contextLimit / 1000).toFixed(0)}K context
```

把 "tokens" 改为 "context"，强调这是上下文窗口的占用量。

### 影响范围

- `api/services/agent-runtime/session-store.ts` — getSessionStats 方法
- `web/src/react/features/sessions/SessionWorkspace.tsx` — SessionStatusCard 组件

两处改动，都是一行。不影响其他消费 `tokenUsage` 的地方（如果有地方需要累计 output，它仍然可以从 `tokenUsage.output` 取到）。
