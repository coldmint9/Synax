# Fallback Tool Progressive Disclosure

## 问题

Wiki 相关 agent 不爱调用 bash 工具 — 因为所有 file.read、file.glob、grep.search 等工具从第一步就暴露给 agent,模型自然会选用那些"更安全"的专用工具,而不是更灵活的 bash。

## 方案

**将能被 bash 替代的工具做成 fallback 工具 — 初始不披露,仅当 bash 连续出错 4 次后自动批量披露。**

## 设计

### 1. 扩展 DisclosureStrategy — 新增 fallback 概念

在 `tool-disclosure.ts` 中增加 `FallbackDisclosureConfig`:

```ts
export interface FallbackDisclosureConfig {
  /** 哪些工具是 fallback（初始隐藏） */
  fallbackToolIds: string[];
  /** bash 连续出错几次后自动披露 */
  consecutiveErrorThreshold: number;
  /** 只追踪这个工具的错误 */
  trackedToolId: string; // 'bash'
}

export interface FallbackDisclosureState {
  consecutiveErrors: number;
  disclosed: boolean;
}
```

### 2. 定义哪些工具是 fallback

对 wiki agent profiles 而言，可以被 bash 替代的工具：
- `file.read` → `cat`/`head`/`tail`
- `file.list` → `ls`
- `file.glob` → `find`
- `grep.search` → `grep`/`rg`
- `diff.read` → `git diff`/`git show`

**不能** 被 bash 替代（必须保留在初始工具集）：
- `wiki.*` 系列（domain-specific，操作内存数据结构）
- `subagent.delegate`（任务委托）
- `tools.escalate`（解锁机制本身）
- `bash`（核心工具）
- `task.*` 系列（如果有的话）

### 3. Profile 声明 fallback 策略

给 `AgentProfile` 增加可选字段：

```ts
export interface AgentProfile {
  // ... existing fields
  fallbackDisclosure?: FallbackDisclosureConfig;
}
```

### 4. 在 loop-runtime 中追踪和触发

在 run loop 中（与现有的 disclosureState 并行）维护 `FallbackDisclosureState`：

```ts
let fallbackState: FallbackDisclosureState | null = profile.fallbackDisclosure
  ? rebuildFallbackState(previousToolCalls, profile.fallbackDisclosure)
  : null;
```

每次 tool_result 返回后：
- 如果 toolId === 'bash' 且 status === 'failed' 或 exitCode !== 0 → `consecutiveErrors++`
- 如果 toolId === 'bash' 且成功 → `consecutiveErrors = 0`
- 如果其他工具 → 不影响计数

当 `consecutiveErrors >= threshold` 时，`disclosed = true`，fallback 工具自动出现。

### 5. 在 generateStep 的 tool filtering 中集成

```ts
// 现有逻辑
const availableTools = this.tools.list().filter(/* allowedCapabilities */);

// 新增：如果 fallback 未披露，从 visibleTools 中过滤掉 fallbackToolIds
let visibleTools = /* disclosure tier filter */;
if (fallbackState && !fallbackState.disclosed) {
  visibleTools = visibleTools.filter(
    t => !profile.fallbackDisclosure!.fallbackToolIds.includes(t.id)
  );
}
```

### 6. 更新 wiki profile 配置

```ts
// wiki-planner、wiki-writer 等：
{
  allowedCapabilities: [
    'bash',           // ← 新增：始终暴露
    'file.read',     // 保留在 allowedCapabilities 中但初始隐藏
    'file.glob',
    'file.list',
    'grep.search',
    // ... wiki.* tools
  ],
  fallbackDisclosure: {
    fallbackToolIds: ['file.read', 'file.list', 'file.glob', 'grep.search', 'diff.read'],
    consecutiveErrorThreshold: 4,
    trackedToolId: 'bash',
  },
}
```

### 7. rebuildFallbackState — 从历史恢复

```ts
export function rebuildFallbackState(
  toolCalls: ToolCallRecord[],
  config: FallbackDisclosureConfig,
): FallbackDisclosureState {
  let consecutiveErrors = 0;
  let disclosed = false;
  for (const call of toolCalls) {
    if (call.toolId === config.trackedToolId) {
      if (call.status === 'failed' || call.error) {
        consecutiveErrors++;
        if (consecutiveErrors >= config.consecutiveErrorThreshold) {
          disclosed = true;
        }
      } else {
        consecutiveErrors = 0;
      }
    }
  }
  return { consecutiveErrors, disclosed };
}
```

### 8. 披露时发出事件 + 系统提示

当 fallback 被触发时：
- 发出 `progress_updated` 事件告知前端
- 在下一步的 systemPrompt 中注入一行提示：`"Fallback tools (file.read, grep.search, etc.) are now available — bash had repeated failures."`

## 涉及文件

1. `api/services/agent-runtime/contracts.ts` — AgentProfile 增加 `fallbackDisclosure?` 字段
2. `api/services/agent-runtime/tool-disclosure.ts` — 新增 FallbackDisclosureConfig/State 类型和函数
3. `api/services/agent-runtime/loop-runtime.ts` — 在 run loop 中追踪 fallback state，在 generateStep 中过滤
4. `api/services/wiki/wiki-loop-profile.ts` — 给 wiki profiles 加 `bash` + `fallbackDisclosure` 配置
5. `api/services/agent-runtime/loop-system-prompt.ts` (如果需要注入披露提示)

## bash 工具错误判定

**确认**：bash 工具从不 throw，总是返回正常 result。ToolCallRecord 的 status 总是 `'completed'`。

判定 bash 是否"出错"的逻辑：
```ts
function isBashError(call: ToolCallRecord): boolean {
  if (call.toolId !== 'bash') return false;
  const ref = call.outputRef as { exitCode?: number } | null;
  return ref != null && ref.exitCode !== 0;
}
```

这样能正确捕获：
- 命令不存在（exitCode 127）
- whitelist 拒绝的命令（bash tool 返回 exitCode null + stderr 错误 → 不算，因为 agent 能从提示中学习）

**补充**：bash 的 whitelist 拒绝不产生 exitCode（result 中 exitCode 为 null），所以需要也检查 `displaySummary` 是否包含 "not allowed" 或直接在 bash tool 的 execute 中对 whitelist 失败设置一个特殊 exitCode（比如返回 exitCode = 126）。

最简方案：**exitCode !== 0 或 exitCode === null 时算错误**。bash 成功执行的唯一标志是 exitCode === 0。
