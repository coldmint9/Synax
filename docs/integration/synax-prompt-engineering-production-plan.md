# Synax Prompt 工程与系统提示词生产化方案

## 1. 文档定位

本文给出 Synax Prompt 工程的生产级优化方案，目标是把当前以字符串拼装为主、但已具备较强运行时能力的实现，演进为可版本化、可解释、可评测、可灰度和可回滚的 Prompt 控制面。

配套背景调研见 [OpenAI Codex 提示词工程调研](./openai-codex-prompt-engineering-research.md)。该调研的核心结论同样适用于 Synax：不要把优化目标定义成“写一份更长的系统提示词”，而要把 Prompt 当成由模型策略、上下文编排、工具协议、权限执行、状态生命周期和评测门禁共同组成的运行时协议。

本文使用以下标签，避免把规划误写成现状：

- **[现状]**：当前仓库源码已经实现，并有对应路径证据。
- **[缺口]**：当前源码没有完整实现，或实现存在明确正确性/治理风险。
- **[建议]**：后续应实现的目标设计，不代表现有能力。
- **[实验]**：必须经过基线、回放或线上灰度验证，不能直接作为默认生产策略。

本轮范围仅为方案文档：**不修改生产运行时代码，不执行 live-provider 验证，也不把本文中的目标接口描述为已经存在。**

## 2. 执行摘要

Synax 不需要从零重建 Agent Runtime。当前实现已经具备分层系统提示词、实际工具集合投影、运行状态 reminder 快照、历史锚点、缓存诊断、上下文压缩策略、硬权限判定和较丰富的单元测试。最合理的演进不是推倒重来，而是在这些能力之上增加一个类型化、确定性的 Prompt 编译控制面。

建议按以下顺序推进：

1. **P0 立即修复正确性问题**：权限描述必须由有效规则求值结果生成；项目规则必须支持仓库根到工作目录的继承并输出来源/截断诊断；建立 Prompt manifest/lint；建立独立 Agent 行为评测 CI；为每次请求解析出明确的模型策略标识，即使首期只有保守 fallback。
2. **P1 完成架构演进**：引入 Prompt IR、确定性编译器、模型家族 policy pack、统一 token 预算器、结构化 runtime delta、无正文可观测性，并以 shadow 和按模型族 canary 迁移请求。
3. **P2 做数据驱动优化**：在质量、安全、成本和缓存数据可信后，再做任务/模型路由、Prompt 变体实验、自动预算调优和内容精简。

首批生产门禁建议如下，均需在首轮基线采集后校准：

- 硬安全违规、权限违规、模式违规：**0**。
- 任务成功率：候选相对基线的下降不得超过 **2 个百分点**；优化目标为提升至少 **5 个百分点**。
- p95 端到端延迟和单位成功成本：默认分别不得恶化超过 **5%**。
- 静态配置未变化时，稳定前缀一致率：至少 **95%**。

任何硬约束违规都应立即停止 rollout 并回滚，不等待统计窗口结束。

## 3. 当前架构与差距基线

### 3.1 当前请求链路

**[现状]** 当前主链路可以概括为：

```text
Agent profile / mode / intent / variant
        +
permission projection / project rules / skills / references
        ↓
loop-prompt.ts 组装系统层
        +
history / current input / runtime reminder snapshot
        ↓
loop-runtime.ts 构造 LlmGatewayRequest 与实际工具集
        ↓
llm-runtime pipeline 应用 cache、media、reasoning、usage 与 protocol options
        ↓
provider adapter 发送 OpenAI Responses / Chat / Anthropic 等请求
        ↓
工具调用进入运行时权限判定和执行路径
```

主要证据：

- 系统层按 language、core、permission、mode、intent、variant、loop hints、skills、project rules、references 的顺序组装，并只描述实际暴露的工具：`api/services/agent-runtime/loop-prompt.ts`。
- mode、Work/Goal 和运行状态由 Synax 专用层生成：`api/services/agent-runtime/synax/synax-mode-prompt.ts`、`api/services/agent-runtime/synax/synax-agent-profile.ts`。
- 工具 schema 和工具名映射在请求时生成，并包含失败工具名修复：`api/services/agent-runtime/loop-ai-tools.ts`。
- gateway 负责模型选择、重试、限流和 pipeline 调用：`api/services/llm-runtime/gateway.ts`。
- pipeline 负责缓存标记、媒体解析、reasoning/usage middleware 和协议参数，再交给 AI SDK：`api/services/llm-runtime/pipeline.ts`。
- OpenAI Responses 专属参数由协议层生成：`api/services/llm-runtime/protocol-options.ts`。

**[缺口]** 以上各层已经存在，但缺少一个统一、类型化的中间表示。当前系统很难在发送前回答“本次到底有哪些 section、每段为何存在、优先级是什么、谁截断了它、是否属于稳定前缀、绑定了哪个模型策略版本”。

### 3.2 能力/缺口矩阵

| 领域 | [现状] 已具备能力 | [缺口] 与风险 | 源码证据 |
|---|---|---|---|
| 提示词分层 | core、permission、mode、intent、variant、skills、项目规则和 reference 已分段拼装；Work 不进入稳定 system 层 | 仍以字符串为最终抽象；没有 section 类型、优先级、信任级、生命周期和版本 manifest | `api/services/agent-runtime/loop-prompt.ts`；`api/services/agent-runtime/__tests__/prompt-composition.test.ts` |
| runtime reminder / snapshot | 动态 Work、计划、队列和 step 状态作为尾部 reminder；每步保存 content、fingerprint、token 和 history anchor；可在 replay 中恢复 | reminder 是完整文本快照，不是字段级 delta；缺少 schema 版本迁移、字段来源和逐 section 预算 | `api/services/agent-runtime/runtime-request-snapshot.ts`；`api/services/agent-runtime/loop-runtime.ts`；`api/services/agent-runtime/context-epoch-store.ts`；`api/services/agent-runtime/__tests__/context-projection.test.ts` |
| 缓存 | references 使用稳定 source identity 或内容 SHA-256 并稳定排序；cache policy 管理 marker/history anchor；诊断只导出 hash/bytes 和 provider usage | 尚无统一 `cacheClass`；稳定前缀变化无法归因到具体编译 section；诊断不是全量 Prompt manifest | `api/services/agent-runtime/loop-prompt.ts`；`api/services/llm-runtime/cache-policy.ts`；`api/services/llm-runtime/cache-diagnostics.ts`；`scripts/diagnose-prompt-cache.ts` |
| 压缩 | 有 prepare/high/hard watermark、最小回收量、cooldown、成本 break-even 和 urgent 决策；有 epoch/replay 测试 | 决策面向整体历史，没有与 Prompt section 生命周期、信任级和业务重要度统一；预算仍有字符截断与 token 预算并存 | `api/services/agent-runtime/context-compaction-policy.ts`；`api/services/agent-runtime/context-compressor.ts`；`api/services/agent-runtime/context-epoch-store.ts`；`scripts/diagnose-context-compaction.ts` |
| token 计量 | 可分别估算 tools、MCP、skills、messages；不把媒体 base64 当文本 token | 尚无发送前的全请求预算分配器，也没有 section 级 `reserved/min/max/onOverflow` 规则 | `api/services/agent-runtime/context-composition.ts`；`api/services/agent-runtime/context-tokenizer.ts` |
| 工具 schema | 只向模型暴露过滤后的实际工具；schema 进入 token 计量；无效工具名有 repair/fallback | 没有 Prompt 版本与工具 schema 版本的兼容 manifest；工具说明变化可能无意破坏稳定前缀或行为 | `api/services/agent-runtime/loop-ai-tools.ts`；`api/services/agent-runtime/context-composition.ts`；`api/services/agent-runtime/__tests__/prompt-composition.test.ts` |
| 权限执行 | tier、override 和有序规则由运行时求值；工具执行不依赖模型自律；Prompt 明确 runtime 决策权威 | `boundary/auto` 分支仍输出“普通 workspace 读写允许”等固定概述，即使有效规则内有显式 deny，也可能产生语义冲突 | `api/services/agent-runtime/permission-tiers.ts`；`api/services/agent-runtime/permission-policy.ts`；`api/services/agent-runtime/prompt-permission-section.ts`；`api/services/agent-runtime/__tests__/permission-policy.test.ts` |
| 项目规则 | 支持 `SYNAX.md`、`CLAUDE.md`、`AGENTS.md`、local 文件、单文件/总字符预算和 `.synax/rules` glob | 先向上找到首个含规则文件的目录，然后只加载该目录；没有 repo root→cwd 继承，也不报告读取失败、来源链和逐文件截断 | `api/services/agent-runtime/synax/synax-instructions.ts`；`api/services/agent-runtime/synax/__tests__/synax-instructions.test.ts` |
| 模型目录 | models.dev 目录提供 modalities、context/output limit、tool-call、reasoning；provider registry 区分 Responses/Chat/Anthropic wire selector | 模型记录没有 `promptPolicyRef`；模型能力与 Prompt 模板、压缩策略、role 映射、工具指导没有显式绑定 | `api/services/llm-runtime/catalog.ts`；`api/services/llm-runtime/types.ts`；`api/services/llm-runtime/providers/provider-registry.ts` |
| provider 边界 | gateway/pipeline 保留协议选项；Responses 参数有独立映射；provider middleware 处理 wire 兼容差异 | Prompt 语义编译与 wire 适配还没有强类型接口边界，后续容易把模型策略散落进 provider 条件分支 | `api/services/llm-runtime/pipeline.ts`；`api/services/llm-runtime/protocol-options.ts`；`api/services/llm-runtime/providers/provider-registry.ts` |
| 测试 | 已有 prompt composition、permission、cache、context projection、compaction 等大量单元测试和本地诊断脚本 | 没有独立 Agent 行为任务集、基线对照和 PR 门禁；当前唯一 GitHub workflow 只在 tag/手动触发时构建桌面包 | `api/services/agent-runtime/__tests__/prompt-composition.test.ts`；`api/services/agent-runtime/__tests__/prompt-permission-section.test.ts`；`package.json`；`.github/workflows/build-desktop.yml` |
| 可观测性 | 有 usage normalizer、context composition、cache block fingerprint、duration/first-token 字段 | 没有统一 `promptVersion`、policy 版本、section hash/token、priority、truncation reason、eval cohort 事件 | `api/services/llm-runtime/usage.ts`；`api/services/llm-runtime/cache-diagnostics.ts`；`api/services/agent-runtime/context-composition.ts` |

### 3.3 必须先处理的四个 P0 风险

1. **权限描述可能与真实规则冲突。** `boundary/auto` 路径在展示完整有效规则之前先输出固定的“普通 workspace 读写允许”概述。有效规则若包含 read/write deny，模型会同时收到互相矛盾的自然语言。硬执行层仍会拒绝，但会增加无效工具调用、审批噪声和绕路风险。证据：`api/services/agent-runtime/prompt-permission-section.ts`。
2. **项目规则缺少目录继承和诊断。** 当前 `resolveInstructionWorkDir()` 找到第一个命中目录后停止，`loadProjectRulesSection()` 只从该目录读取规则。仓库根规则和子目录规则不能按作用域共同生效，且读取失败被静默忽略。证据：`api/services/agent-runtime/synax/synax-instructions.ts`。
3. **模型目录没有 Prompt policy 绑定。** 当前目录只映射通用模型能力，provider registry 只选择 wire selector。不存在可审计的“模型/模型家族 → Prompt policy 版本”关系。证据：`api/services/llm-runtime/catalog.ts`、`api/services/llm-runtime/providers/provider-registry.ts`。
4. **缺少独立 Agent 行为评测 CI。** `package.json` 有通用 test/build 脚本和缓存/压缩诊断脚本，但没有 Agent eval 命令；唯一 workflow 是桌面构建，未运行行为回放门禁。证据：`package.json`、`scripts/diagnose-prompt-cache.ts`、`scripts/diagnose-context-compaction.ts`、`.github/workflows/build-desktop.yml`。

## 4. 目标架构

### 4.1 设计原则

**[建议]** 目标架构遵循七条约束：

1. Prompt 的最小治理单元是有类型的 section，不是任意字符串。
2. 同一输入必须产生字节级确定的编译结果和 manifest；时间戳、随机 ID 不得进入稳定前缀。
3. `role` 是 provider wire 表达，`trust` 是 Synax 内部来源属性，两者不能混为一谈。
4. 硬权限、模式门禁和 Goal 接受条件继续由服务端执行；Prompt 只投影事实，不成为授权来源。
5. 模型家族策略由本地、版本化、受测的 policy pack 决定；远程 models.dev 元数据不能直接注入指令。
6. provider adapter 只做协议转换，不决定业务优先级、不静默删减 section、不生成产品语义。
7. 所有 rollout 必须能按 compiler、policy、模型家族和 cohort 定位并一键回退到旧编译器。

### 4.2 类型化 Prompt IR

建议新增类似以下内部协议；字段名可在实现 PR 中调整，但语义必须保留：

```ts
type PromptRole = "system" | "developer" | "user" | "tool";
type PromptTrust =
  | "platform"
  | "server-state"
  | "project-instruction"
  | "user-input"
  | "retrieved-evidence"
  | "tool-output";
type PromptLifecycle = "release" | "session" | "turn" | "step";
type PromptCacheClass =
  | "stable-prefix"
  | "session-stable"
  | "dynamic-tail"
  | "never-cache";

interface PromptSection {
  id: string;
  schemaVersion: 1;
  contentVersion: string;
  role: PromptRole;
  source: { kind: string; id: string; path?: string };
  trust: PromptTrust;
  priority: number;
  lifecycle: PromptLifecycle;
  cacheClass: PromptCacheClass;
  budget: {
    minTokens: number;
    maxTokens: number;
    reserved: boolean;
    onOverflow: "reject" | "truncate-tail" | "summarize" | "drop";
  };
  content: string | StructuredPromptContent;
}

interface PromptManifest {
  manifestVersion: 1;
  promptVersion: string;
  compilerVersion: string;
  modelPolicyVersion: string;
  sections: Array<{
    id: string;
    role: PromptRole;
    sourceKind: string;
    trust: PromptTrust;
    priority: number;
    lifecycle: PromptLifecycle;
    cacheClass: PromptCacheClass;
    contentVersion: string;
    contentHmac: string;
    tokenCount: number;
    truncationReason: string | null;
  }>;
  totalTokens: number;
  toolSchemaTokens: number;
  historyAnchorStatus: "absent" | "stable" | "changed" | "invalid";
}
```

生产持久化只保存 manifest 元数据，不保存 `PromptSection.content`。`contentHmac` 使用服务端轮换密钥计算，避免低熵 section 被普通 SHA-256 字典反推。

### 4.3 确定性编译与优先级

**[建议]** 编译器输入应是显式的 `PromptCompileInput`，输出为 `{ messages, tools, manifest }`。编译顺序固定如下：

```text
0. 服务端硬约束（不进入 Prompt，最高权威）
1. 平台核心规则与响应语言
2. 有效权限真值投影、mode/goal 边界
3. 模型家族 policy pack
4. profile / variant / intent overlay
5. 项目规则（repo root → cwd；同类规则 deeper wins）
6. skills 索引和可信 reference 元数据
7. 会话历史与压缩摘要
8. 当前用户输入
9. 最新 runtime reminder / queued input delta
10. 工具结果（按原调用关系保留，视为不可信证据）
```

冲突处理必须可判定：

- 服务端 deny、模式门禁和未批准计划不能被任何 Prompt 内容覆盖。
- platform/server-state section 高于 project/user/retrieval，但 server-state 只陈述已持久化事实，不扩张用户授权。
- 项目规则按目录从浅到深合并；更深目录可覆盖同一规则键，但不能覆盖平台和权限边界。
- 当前用户输入决定本轮目标，但不能把仓库文本、工具输出或历史摘要中的“指令”提升为用户授权。
- retrieved evidence 和 tool output 默认只作为数据；编译器使用明确边界和来源标签，禁止其闭合外围控制标记。
- 相同优先级按稳定的 `source.kind/source.id/id/contentVersion` 排序，禁止依赖文件系统返回顺序。
- 非法冲突、重复唯一 section、缺失必需 section 或预算不足以容纳 reserved section 时，编译失败并回退旧编译器，不能静默发送半份控制协议。

### 4.4 稳定前缀与动态尾部

**[建议]** 编译后按 cache class 形成以下布局：

```text
[stable-prefix]
platform core + model policy + stable profile rules

[session-stable]
permission projection version + project rule chain + tools schema + selected references

[history]
previous turns + compaction summary + history anchor

[dynamic-tail]
current user input + latest runtime reminder + queue delta
```

规则如下：

- 静态配置未变化时，`stable-prefix` 的规范化字节必须不变；目标一致率至少 95%，剩余变化必须有 manifest 原因。
- `stepIndex`、时间戳、数据库实例 ID、临时 block ID 和完整 Work 快照不得污染稳定前缀。
- tools 仍作为 provider 的结构化 schema 发送，manifest 只记录稳定排序后的 schema HMAC/token；工具可见性变化必须产生明确原因。
- runtime reminder 保持在请求尾部以保护缓存，但由类型化字段渲染，而不是在多处手写同义文本。
- history anchor 的 `absent/stable/changed/invalid` 状态进入 manifest；provider 报告的 cache read/write 才能作为真实缓存命中证据。

### 4.5 模型家族策略包

**[建议]** 不在远程 catalog 中直接保存长提示词。新增本地、审阅过的 `PromptPolicyPack`，由 resolver 根据 provider、api format、模型 ID、reasoning/tool 能力和显式 override 解析：

```ts
interface PromptPolicyPack {
  id: string;
  version: string;
  family: "openai-reasoning" | "anthropic" | "gemini" | "generic";
  baseInstructionVersion: string;
  roleStrategy: "native-developer" | "system-folded";
  toolGuidanceStyle: "concise" | "explicit";
  reminderTemplateVersion: string;
  compactionPolicyId: string;
  budgetPolicyId: string;
  cachePolicyId: string;
}
```

模型解析规则：

1. 精确本地 override 优先。
2. 受测的模型家族规则其次。
3. 未识别模型必须落到 `generic` 保守策略，并记录 `policyFallback=true`。
4. models.dev 的 `reasoning/toolCall/contextLimit` 只能作为能力输入，不能携带任意 Prompt 文本。
5. policy 版本变更必须触发离线回放；不同模型家族分别发布，不能用总体均值掩盖单一模型回归。

`api/services/llm-runtime/catalog.ts` 继续负责模型事实目录；建议在 resolver 输出中增加 `promptPolicyRef`，而不是把 Prompt 内容塞进 catalog 或 provider factory。

### 4.6 项目规则继承与来源诊断

**[建议]** 项目规则加载器应：

1. 确定 workspace/repository 边界，禁止越界向父目录扫描。
2. 收集从 repo root 到当前工作目录沿途的规则文件。
3. 每层按固定顺序加载 `SYNAX.md`、`CLAUDE.md`、`AGENTS.md`、local 文件；local 文件是否允许进入共享日志由配置决定。
4. 将 `.synax/rules/*.md` 按规范化相对路径和稳定文件名顺序匹配。
5. 为每个来源记录 `relativePath`、文件类型、原始字节、纳入字节、HMAC、优先级、截断原因和读取错误码。
6. 先按单文件 token 上限处理，再按项目规则总预算处理；不得继续使用字符数假装 token 数。
7. deeper rule 只覆盖同一可识别规则键；纯文本无法判定覆盖时按顺序全部保留，并明确显示来源边界。

读取失败不能静默变成“没有规则”。默认行为应是记录诊断并继续；对标记为 required/locked 的规则读取失败则中止编译并回退，不发送不完整约束。

### 4.7 Token 预算与压缩

**[建议]** 预算器使用以下恒等式：

```text
availableInput = modelContextLimit
               - reservedOutput
               - providerSafetyMargin
               - mediaReserve
               - toolSchemaTokens
```

随后按 section 分配预算：

- 不可丢弃：平台核心、权限真值、mode/goal、当前用户任务、最新 runtime reminder。
- 可截断但必须保留来源：项目规则、skills 索引、references。
- 可摘要：较旧历史、成功工具结果、重复诊断。
- 可淘汰：低相关 retrieval、已被新状态完全替代的旧 reminder、重复失败噪声。

预算器应复用 `context-tokenizer.ts` 的模型 token 计量，并与 `context-compaction-policy.ts` 的 watermark/economics 合并：编译预算决定“本次请求能放什么”，compaction policy 决定“会话历史何时重建”。任何截断、摘要、淘汰都必须写入 manifest；reserved section 放不下时必须阻断并给出可观察错误，不能截断安全或任务边界。

### 4.8 权限真值投影

**[建议]** 权限 Prompt 必须是执行策略的只读投影：

1. 输入只接受最终 `effectiveRules`、subsession 状态和 runtime resolver。
2. 默认 read/write/delete/shell/network/external-path 描述均调用与执行路径相同的求值函数。
3. scoped deny/ask/allow 按运行时实际的 last-rule-wins 顺序输出；不得先写“通常允许”再附带相反规则。
4. tier 名称只用于解释审批模式，不用于推导某个操作必然 allow。
5. Prompt 中继续声明 runtime authoritative，但不能依赖这句话掩盖错误摘要。
6. 编译 manifest 记录规则集 HMAC、投影版本和代表性决策矩阵，不记录敏感路径正文。

工具执行仍由 `permission-policy.ts` 和各工具 gate 强制执行。即使 Prompt section 缺失或模型无视它，deny 也必须生效。

### 4.9 Provider wire 层边界

**[建议]** 编译器在进入 `llm-runtime` 前完成所有产品语义决策。provider 层只允许：

- 将 IR role 映射到 provider 支持的 system/developer/user/tool 结构；
- 应用 provider cache marker、reasoning、media 和 response options；
- 做已测试的 JSON Schema / SSE / 文件兼容转换；
- 返回 usage、cache、latency 和 finish reason。

provider 层禁止：

- 根据 provider 名称偷偷追加行为指令；
- 重新排序有语义优先级的 section；
- 静默截断或删除 section；
- 把 wire 兼容提示与 Synax 产品策略混在同一模板；
- 把 provider cache 命中估算成事实。

建议接口为 `compilePrompt(...) -> CompiledPrompt`，再由 `toProviderRequest(compiled, selection)` 做协议适配。现有 `api/services/llm-runtime/prompt.ts`、`cache-policy.ts`、`protocol-options.ts` 和 `pipeline.ts` 可作为 wire 层基础，不必重写 gateway。

## 5. 分阶段路线图

下面每项都明确问题、范围、预期文件、依赖、验收、风险和回滚。标记为“新增”的路径是建议，不代表当前仓库已有文件。

### 5.1 P0：立即修复（建议 0-30 天）

#### P0-1 权限真值投影

- **问题**：`boundary/auto` 固定概述可能与有效 deny 规则冲突。
- **改动范围**：让所有 tier 走统一决策投影；补充 `approval_mode + explicit deny`、scoped rule、subsession 和 last-rule-wins 测试。
- **预期文件**：`api/services/agent-runtime/prompt-permission-section.ts`、`permission-policy.ts`、`__tests__/prompt-permission-section.test.ts`。
- **依赖**：无，可独立首发。
- **验收**：对每个测试操作，Prompt 描述与 `resolvePermissionDecision()` 完全一致；硬安全/权限违规为 0。
- **风险**：文案变长，可能影响缓存；通过稳定序列化和仅输出非默认例外控制。
- **回滚**：`SYNAX_PERMISSION_PROJECTION_V2` 关闭后恢复旧 renderer；执行层规则不回滚。

#### P0-2 项目规则继承与诊断

- **问题**：只使用首个命中目录，缺少 root→cwd 继承、来源链和读取/截断诊断。
- **改动范围**：新增 repo boundary discovery、稳定目录链、token 预算和 provenance；保持现有文件名兼容。
- **预期文件**：`api/services/agent-runtime/synax/synax-instructions.ts`、`synax-context-types.ts`、`synax/__tests__/synax-instructions.test.ts`；建议新增 `synax/project-rule-chain.ts`。
- **依赖**：复用 tokenizer；不依赖新编译器。
- **验收**：fixture 覆盖根/子目录、多个文件、glob、symlink/越界、读取失败和截断；输出顺序在不同文件系统遍历顺序下相同。
- **风险**：继承后规则 token 增长或旧项目行为变化。
- **回滚**：`SYNAX_PROJECT_RULE_CHAIN_V2` 按 session 固定；保留旧 single-directory loader 至少两个版本。

#### P0-3 Prompt manifest、确定性 lint 与 shadow compiler façade

- **问题**：当前无法追踪 section 来源、稳定性和冲突，字符串测试难以覆盖结构性错误。
- **改动范围**：先把现有输出包装成 IR/manifest，不改变线上 wire 内容；添加唯一 section、稳定排序、禁止动态字段进入 stable-prefix、禁止未转义 reference 控制标记等 lint。
- **预期文件**：建议新增 `api/services/agent-runtime/prompt-ir.ts`、`prompt-manifest.ts`、`prompt-compiler.ts`、`prompt-lint.ts` 及 `__tests__/prompt-compiler.test.ts`；适配 `loop-prompt.ts`。
- **依赖**：P0-1、P0-2 的 provenance 接口可并行，最终合并。
- **验收**：相同输入重复编译 100 次，messages 与 manifest 字节一致；旧/新 wire 内容在兼容模式下等价；lint 对故意冲突 fixture 必须失败。
- **风险**：双编译增加 CPU 和诊断量。
- **回滚**：shadow 默认不发送 V2；关闭 `SYNAX_PROMPT_COMPILER_SHADOW` 即停用，无数据迁移。

#### P0-4 独立 Agent 行为评测与 CI

- **问题**：现有单元测试验证函数，但不能证明真实任务行为、误完成率和工具效率未回归。
- **改动范围**：建立无 provider 的 deterministic suite、record/replay 任务集、评分器和 PR workflow；live suite 保持显式 opt-in。
- **预期文件**：建议新增 `evals/agent/`、`scripts/evaluate-agent.ts`、`api/services/agent-runtime/__tests__/prompt-invariants.test.ts`、`.github/workflows/agent-eval.yml`；在 `package.json` 增加 `eval:agent`。
- **依赖**：manifest schema；第一版可先消费旧请求 snapshot。
- **验收**：PR 必跑离线门禁；报告同时给出 baseline/candidate、任务级差异和硬违规；任何硬违规使 CI 失败。
- **风险**：fixture 过拟合或评分器把表达风格当成功。
- **回滚**：门禁可临时降为 report-only，但硬权限 invariant 不允许跳过；评测不进入生产请求链。

#### P0-5 模型策略身份与保守 fallback

- **问题**：模型目录没有 Prompt policy 绑定，无法按模型族评测和回滚。
- **改动范围**：先增加本地 resolver 和 `generic-v1`，只记录 policy identity，不在 P0 引入大幅模型差异。
- **预期文件**：建议新增 `api/services/agent-runtime/model-prompt-policy.ts`；扩展 `api/services/llm-runtime/resolver.ts`、`types.ts` 和对应测试。
- **依赖**：manifest；不依赖 provider factory 修改。
- **验收**：每个 resolved model 恰有一个 policy ID/version；未知模型显式 fallback；远程 catalog 内容不能指定模板路径或正文。
- **风险**：错误模型家族识别。
- **回滚**：全部模型固定回 `generic-v1`；按模型族 flag 隔离。

### 5.2 P1：架构演进（建议 31-60 天）

#### P1-1 正式切换 Prompt IR 编译器

- **问题**：shadow manifest 仍依赖旧字符串组装，无法统一预算和生命周期。
- **改动范围**：逐个把 core、mode、variant、project rules、references、runtime reminder 迁移为 section producer；编译器成为唯一排序入口。
- **预期文件**：`prompt-compiler.ts`、`prompt-ir.ts`、`loop-prompt.ts`、`synax/synax-mode-prompt.ts`、`runtime-request-snapshot.ts`。
- **依赖**：全部 P0。
- **验收**：离线任务非劣、manifest 完整、同输入确定性、稳定前缀一致率 ≥95%。
- **风险**：role 或顺序的细微变化导致模型行为漂移。
- **回滚**：session-sticky 的 compiler version；保留 V1 完整发送路径至少 30 天/两个稳定版本。

#### P1-2 模型家族 policy pack

- **问题**：单一提示风格不能稳定适配不同 role、reasoning、tool-call 和缓存语义。
- **改动范围**：引入 OpenAI reasoning、Anthropic、Gemini、generic 四个最小策略包；只改变有评测证据的行为。
- **预期文件**：建议新增 `api/services/agent-runtime/prompt-policies/*.ts`、`model-prompt-policy.ts`；扩展 resolver/catalog 测试。
- **依赖**：P1-1、P0-4。
- **验收**：每个模型族分别达到质量/延迟/成本门禁；未知模型仍使用 generic。
- **风险**：策略分叉过多导致维护成本和行为不可预测。
- **回滚**：单个 family 回退到前一 policy version，不影响其他 family。

#### P1-3 统一 token 预算器与生命周期压缩

- **问题**：字符截断、请求 token 估算和历史压缩尚未统一。
- **改动范围**：section token allocation、reserved section、淘汰优先级、截断原因；让 compaction policy 消费相同预算信息。
- **预期文件**：建议新增 `prompt-budget.ts`；修改 `context-composition.ts`、`context-compaction-policy.ts`、`context-compressor.ts`、`synax-instructions.ts`。
- **依赖**：P1-1、模型 context limit 和 tokenizer。
- **验收**：hard window fixture 不超限；任何 reserved section 不被截断；长上下文回放任务成功率达到门禁。
- **风险**：tokenizer 与 provider 实际计费不一致。
- **回滚**：按 policy pack 回旧 watermarks；保留 provider usage 与估算值的差异监控。

#### P1-4 结构化 runtime delta 与注入防护

- **问题**：完整 reminder 文本重复，且控制状态与普通用户文本都通过消息内容表达。
- **改动范围**：定义版本化 runtime state schema、上一快照 diff、可信 renderer；reference/tool output 始终包装为数据块并转义控制边界。
- **预期文件**：`runtime-request-snapshot.ts`、`context-epoch-store.ts`、`loop-runtime.ts`；建议新增 `runtime-state-delta.ts`。
- **依赖**：P1-1、history anchor。
- **验收**：replay 后状态等价；旧 snapshot 可迁移或回退；注入 corpus 不能伪造 Work/permission/mode 状态。
- **风险**：delta 丢字段造成长任务状态漂移。
- **回滚**：检测 schema/version/anchor 异常时发送完整 V1 reminder，并记录 fallback reason。

#### P1-5 Prompt 可观测性与 dashboard

- **问题**：现有 cache/context 指标无法解释具体 section 变化和 rollout 质量。
- **改动范围**：统一无正文事件、聚合指标、模型族 dashboard 和自动回滚信号。
- **预期文件**：建议新增 `api/services/agent-runtime/prompt-telemetry.ts`；扩展 `llm-runtime/cache-diagnostics.ts`、usage/session stats 存储和运维 dashboard 配置。
- **依赖**：manifest、eval cohort、provider usage normalization。
- **验收**：能从 request/session 定位 compiler/policy/cohort 和截断原因，但日志中找不到完整 prompt、凭据或工具结果。
- **风险**：hash/linkage 形成侧信道或高基数字段导致成本上升。
- **回滚**：关闭详细 section 事件，仅保留版本和聚合计数；不影响请求发送。

### 5.3 P2：实验优化（建议 61-90 天及以后）

#### P2-1 Prompt 变体与内容精简实验

- **问题**：没有数据证明每条指令都提高行为质量，重复规则会浪费注意力和缓存写入。
- **改动范围**：在 policy pack 中建立版本化、session-sticky 的变体；实验分配由独立 cohort 配置管理，禁止在运行时代码中散落 A/B 文案。
- **预期文件**：扩展 `api/services/agent-runtime/prompt-policies/*.ts`、`api/services/agent-runtime/model-prompt-policy.ts` 和 `evals/agent/` 下的实验定义。
- **依赖**：P1 可观测性和 canary。
- **验收**：成功率提升目标 ≥5 个百分点，或在质量非劣下显著降低 token/成本。
- **风险**：实验分配跨会话漂移，或同时改变多个变量导致结论不可归因。
- **回滚**：关闭指定 cohort，将该模型族固定回已发布 policy version。

#### P2-2 数据驱动模型/任务路由

- **问题**：不同任务可能需要不同模型、reasoning 和工具指导，但静态规则无法优化单位成功成本。
- **改动范围**：增加独立 routing policy，只消费脱敏聚合特征，并将任务族、模型选择和 fallback 原因写入无正文 telemetry。
- **预期文件**：扩展 `api/services/llm-runtime/resolver.ts`；建议新增 `api/services/agent-runtime/model-routing-policy.ts` 及对应离线评测 fixture。
- **依赖**：可信任务成功标签、成本和延迟数据。
- **验收**：按任务类别同时满足硬门禁和单位成功成本目标。
- **风险**：聚合指标掩盖少数任务族回归，或路由反馈回路固化错误选择。
- **回滚**：逐任务族关闭动态路由并恢复静态模型选择；保留路由决策日志用于离线复盘。

#### P2-3 自适应 retrieval 与预算

- **问题**：固定 reference/skill/history 配额不能适配任务复杂度。
- **改动范围**：在统一预算器和 context selection 层增加受限策略；模型只能在已授权来源集合内调整配额，不能自行扩大权限或上下文来源。
- **预期文件**：扩展 `api/services/agent-runtime/prompt-budget.ts`、`api/services/agent-runtime/context-composition.ts` 和 `evals/agent/` 的长上下文任务集。
- **依赖**：P1-3、相关性标签、长上下文集。
- **验收**：质量非劣且平均输入 token 或 p95 延迟下降；所有淘汰有 manifest 原因。
- **风险**：相关性判断遗漏关键证据，造成看似节省 token 但任务失败。
- **回滚**：按模型族或任务族关闭自适应策略，恢复上一版固定预算 policy。

P2 只允许作为 **[实验]** 推进，不能在缺少基线和自动回滚时直接全量。

## 6. 生产级评测方案

### 6.1 五层评测金字塔

1. **离线确定性测试（PR 必跑）**：IR schema、排序、role 映射、规则继承、权限投影、token 预算、cache class、snapshot replay、manifest redaction。
2. **真实任务 record/replay（PR 必跑小集，nightly 跑全量）**：固定仓库 fixture、用户输入、工具结果和预期 workspace diff，不调用外部模型也能验证编译与执行 invariant。
3. **Agent 行为回放（PR report + 合并门禁）**：对固定模型输出或 deterministic fake model 执行完整 tool loop，评估是否选对工具、是否误完成、是否越权。
4. **对抗与长上下文集（nightly/发布必跑）**：prompt injection、权限拒绝、mode/goal、脏工作区、失败恢复、压缩/replay、queue ordering 和 context hard limit。
5. **可选多模型 live eval（手动或受控定时）**：使用已授权连接，对 OpenAI reasoning、Anthropic、Gemini、generic-compatible 各选代表模型；凭据不通过 CLI 传入，失败不得记作零 usage。

`scripts/diagnose-prompt-cache.ts` 和 `scripts/diagnose-context-compaction.ts` 可作为诊断组件复用，但它们不是行为评测的替代品。

### 6.2 首批任务集

| 任务族 | 关键场景 | 主要断言 |
|---|---|---|
| 编码 | 小修复、跨文件变更、已有测试 | 先读后改、改动范围正确、聚焦验证、diff 符合预期 |
| 审查 | 有缺陷/无缺陷 diff | finding 优先、严重级准确、不擅自改代码 |
| 探索 | 架构定位、证据不足 | 引用真实路径、不臆造、不重复大范围扫描 |
| 计划 | 未批准/已批准计划 | 计划模式不写文件；批准后才执行；保留验收条件 |
| 权限 | boundary/auto/unrestricted、显式 deny、等待审批 | Prompt 与 resolver 一致；deny 无工具副作用；不绕路 |
| 脏工作区 | 用户改动与目标文件重叠/不重叠 | 不 reset/stash/覆盖；只改授权范围 |
| 失败恢复 | 工具失败、无效工具名、测试失败、provider error | 使用合理 fallback；不谎报成功；保留失败证据 |
| 长上下文 | 多轮历史、压缩、snapshot replay、queued input | 当前 Work/用户目标/权限不丢失；顺序稳定 |
| 注入 | repository、reference、tool result 伪造 system/reminder | 内容只作为证据；不能改变 mode、权限或 Work |
| 多模型 | role/tool/reasoning/cache 差异 | 每个 family 单独达到门禁，wire 请求合法 |

所有任务 fixture 必须声明：授权范围、允许工具、初始文件树、预期副作用、禁止副作用、完成证据和评分 rubric。不能仅比较最终自然语言字符串。

### 6.3 指标定义

- **任务成功率**：满足任务全部必需断言的任务数 / 有效任务数。部分分只用于诊断，不掩盖必需断言失败。
- **硬约束违规率**：权限、模式、数据边界、破坏性操作或伪造接受证据的任务数 / 有效任务数。目标恒为 0。
- **误完成率**：未满足验收条件、没有成功验证或仍有未处理失败，却输出完成/调用完成控制工具的任务占比。
- **工具效率**：完成任务的有效工具调用数、重复读取率、无效/失败调用率、审批噪声和调用序列长度；按任务复杂度归一化。
- **输入/输出 token**：provider 报告优先；本地估算单独标记，绝不混作计费事实。
- **缓存指标**：稳定前缀一致率、history anchor 变化率、provider-reported cache read/write coverage 和 cache read rate。
- **延迟**：首 token、首有效 tool call、端到端完成的 p50/p95；失败重试计入端到端延迟。
- **成本**：总 provider 成本 / 成功任务数，记为单位成功成本；usage 或价格未知时显示 unknown，不填 0。
- **压缩质量**：压缩后关键约束 recall、任务成功率、误完成率以及每次 compaction 的净 token 回收。

### 6.4 门禁与统计方法

首批建议门槛：

| 指标 | 合并/发布门槛 | 动作 |
|---|---|---|
| 硬安全、权限、模式违规 | 必须为 0 | 任一例立即阻断或回滚 |
| 任务成功率 | 相对基线下降不超过 2 个百分点 | 超限阻断；稳定后目标提升至少 5 个百分点 |
| 误完成率 | 不得高于基线，且关键任务为 0 | 超限阻断 |
| p95 端到端延迟 | 相对基线恶化不超过 5% | 超限暂停 rollout/回滚 |
| 单位成功成本 | 相对基线恶化不超过 5% | 超限暂停 rollout/回滚 |
| 稳定前缀一致率 | 静态配置未变时 ≥95% | 低于门槛先停止扩量并定位 section |

这些阈值是首轮建议值，**必须在首轮基线后按模型族和任务族校准**。校准只能基于观察到的方差和业务 SLO，不能为了让候选版本通过而事后放宽。

统计规则：

- baseline 与 candidate 使用相同任务、初始状态、模型版本、temperature/reasoning 配置和工具集合。
- 非确定 live eval 每个任务至少运行 3 个 seed/重复样本；报告配对差值和 bootstrap 95% 置信区间。
- 样本不足时只允许“继续采样”，不能宣布非劣。
- 所有总体指标必须同时按 model family、任务族、权限 tier、compiler/policy version 分层。
- Prompt 文案快照只用于 review；生产门禁基于结构 invariant 和行为指标。

### 6.5 CI 设计

建议新增 `.github/workflows/agent-eval.yml`：

- PR：typecheck、Prompt lint、确定性编译、权限/项目规则/预算单测、小型 replay，不需要凭据。
- main/nightly：完整 replay、注入集、长上下文/压缩集、基线趋势。
- release/manual：可选 live matrix；只使用受控 secret store 中现有连接，不接受命令行 API key。
- live 失败必须显式失败并标记 usage unknown；不得把“没有报告”解释为“没有成本/没有缓存回归”。
- CI artifact 只保留任务 ID、版本、指标、diff 摘要和脱敏 manifest，不上传完整 prompt、仓库私有正文或任意工具结果。

## 7. 无敏感正文的可观测性

### 7.1 事件字段

**[建议]** 每个请求记录一个版本化 `PromptCompilationEvent`：

```text
eventVersion
requestId / sessionIdHash / runIdHash / stepIdHash
promptVersion / compilerVersion / modelPolicyVersion
modelFamily / modelIdHash / provider / protocol
mode / profileId / variantId / permissionTier
sectionCount
sections[].id
sections[].sourceKind
sections[].contentVersion
sections[].contentHmac
sections[].tokenCount
sections[].priority
sections[].trust
sections[].lifecycle
sections[].cacheClass
sections[].truncationReason
toolSchemaHmac / toolSchemaTokens / activeToolCount
inputBudget / estimatedInputTokens / providerInputTokens
historyAnchorStatus / historyAnchorChangedReason
compactionAction / compactionReason / reclaimedTokens
cacheReadTokens / cacheWriteTokens / cacheFieldAvailability
firstTokenMs / endToEndMs / retryCount
evalCohort / featureFlags
outcome / finishReason / fallbackReason
```

其中 `promptVersion` 表示整体编译协议，`modelPolicyVersion` 表示模型家族策略，二者必须分开。`historyAnchorStatus` 至少区分 absent、stable、changed、invalid；`truncationReason` 使用有限枚举，如 `section-cap`、`global-budget`、`provider-hard-limit`、`invalid-source`、`superseded`。

### 7.2 明确禁止记录的内容

无论 debug、eval 还是异常路径，都不得默认记录：

- 完整 system/developer/user prompt；
- 项目规则、用户消息、reference 或 memory 正文；
- API key、Authorization/header、cookie、环境凭据；
- 任意工具调用参数和工具结果全文；
- 文件内容、patch 正文、终端 stdout/stderr 全文；
- provider 原始 request/response body。

允许记录有限枚举、token/bytes、版本、HMAC、错误类别和经过专门脱敏的短摘要。HMAC 密钥按环境轮换；不同环境不共享，原始 session/run ID 使用不可逆环境盐。高基数 section 明细采用采样和短保留期，聚合指标采用更长保留期。

### 7.3 Dashboard 与告警

至少提供以下视图：

- compiler/policy/model family 的任务成功率、误完成率和硬违规。
- stable-prefix 一致率、首个变化 section、cache read coverage/rate。
- section token 构成、截断率、compaction action/reason。
- p50/p95 首 token和端到端延迟、重试率、单位成功成本。
- fallback 比例：旧编译器、generic policy、完整 reminder、invalid anchor。

告警不能只看总体均值；任一模型族出现硬违规、稳定前缀突然下降或 fallback 激增都应单独报警。

## 8. 发布、灰度与自动回滚

### 8.1 Feature flags

建议使用独立、可组合且可按模型族覆盖的 flags：

```text
promptCompilerV2
permissionProjectionV2
projectRuleChainV2
modelPolicyPackV1
promptBudgetV1
runtimeDeltaV1
promptTelemetryV1
```

flag 分配必须 session-sticky。一个会话中途不得在 V1/V2 compiler 之间来回切换；必要切换时创建新 epoch 并发送完整状态恢复。

### 8.2 发布流程

1. **离线**：全部确定性、replay、对抗和长上下文门禁通过。
2. **Shadow**：V1 正常发送，V2 仅编译 manifest；比较 section、token、role、权限矩阵和稳定前缀，不发送第二个 provider 请求。建议至少 48 小时或每模型族 500 个有效会话。
3. **5% canary**：按模型族独立开启，内部/低风险流量优先；至少 24 小时和 200 个可评分任务。
4. **25%**：至少两个完整业务周期或 500 个可评分任务；复核分层指标。
5. **50%**：观察 p95、成本、cache、fallback 和支持工单；禁止同时改变模型版本。
6. **100%**：满足所有门禁后全量；旧 compiler 保留至少 30 天或两个稳定版本。

从 5% 到 25% 到 50% 到 100% 的每次扩量都需要机器门禁和责任人确认。不同模型族独立推进，Anthropic 通过不能替 OpenAI Responses 解锁，反之亦然。

### 8.3 自动回滚条件

立即回滚：

- 任一已确认的硬安全、权限或模式违规。
- reserved section 缺失、权限投影与 resolver 不一致、跨 workspace 项目规则泄漏。
- manifest/wire schema 无法解析且 fallback 失败。

窗口回滚：

- 任务成功率相对基线下降超过 2 个百分点，且置信区间/连续窗口支持回归判断。
- p95 端到端延迟或单位成功成本相对基线恶化超过 5%。
- 静态配置未变化的稳定前缀一致率低于 95%。
- generic-policy、full-reminder 或 old-compiler fallback 比例连续两个窗口异常升高。

回滚粒度按 `compilerVersion + modelPolicyVersion + modelFamily`，不得为了一个模型族的问题全局关闭不相关修复。硬违规例外：先回滚受影响全部 cohort，再调查。

### 8.4 数据与兼容策略

- manifest 和 telemetry schema 只做 additive migration；reader 必须容忍未知字段。
- snapshot/delta 均带版本；新 reader 支持旧完整 snapshot，旧 reader 不读 V2 时回退完整 reminder。
- 保留 V1 renderer、旧 policy 和 feature flag，直到 100% 后至少 30 天/两个稳定版本。
- rollback 不依赖 destructive database migration；V2 元数据缺失时 V1 路径仍可运行。

## 9. 文件级 Change Map 与建议 PR

| PR | 目标 | 主要文件 | 依赖 | 类型 |
|---|---|---|---|---|
| PR-1 | 权限真值投影与回归测试 | `prompt-permission-section.ts`、`permission-policy.ts`、对应 tests | 无 | P0 立即修复 |
| PR-2 | root→cwd 项目规则链和 provenance | `synax-instructions.ts`、`synax-context-types.ts`、新增 `project-rule-chain.ts` | tokenizer | P0 立即修复 |
| PR-3 | Prompt IR/manifest/lint 的 shadow 输出 | 新增 `prompt-ir.ts`、`prompt-manifest.ts`、`prompt-compiler.ts`、`prompt-lint.ts` | PR-1/2 接口 | P0 基础设施 |
| PR-4 | Agent eval harness 和 CI | 新增 `evals/agent/`、`scripts/evaluate-agent.ts`、`.github/workflows/agent-eval.yml` | PR-3 manifest | P0 门禁 |
| PR-5 | 模型策略 resolver 与 generic-v1 | 新增 `model-prompt-policy.ts`，修改 `llm-runtime/resolver.ts`/`types.ts` | PR-3/4 | P0→P1 |
| PR-6 | 正式 section producers 与 V2 compiler | `loop-prompt.ts`、mode/profile/runtime snapshot | PR-1 至 PR-5 | P1 架构演进 |
| PR-7 | token budget + compaction integration | 新增 `prompt-budget.ts`，修改 composition/compaction/compressor | PR-6 | P1 架构演进 |
| PR-8 | runtime delta + injection suite | 新增 `runtime-state-delta.ts`，修改 loop runtime/epoch store | PR-6/7 | P1 架构演进 |
| PR-9 | telemetry、dashboard、canary controller | 新增 `prompt-telemetry.ts`，扩展 cache/usage/stats | PR-3/4/6 | P1 发布能力 |
| PR-10+ | 变体、路由、自适应预算实验 | policy/evals/resolver | 全部 P1 | P2 实验优化 |

每个 PR 均应只引入一个可独立回滚的行为变化；不要把“换编译器、换模型策略、换模型版本”放在同一次 canary 中。

## 10. 30/60/90 天里程碑

### 30 天

- 完成 P0-1、P0-2；权限投影和项目规则链有确定性测试。
- 完成 Prompt manifest shadow 和 lint；记录首轮 stable-prefix/token 基线。
- 建立 Agent eval 小集和 PR workflow；硬违规门禁为 0。
- 所有模型解析出显式 `modelPolicyVersion=generic-v1` 或受控 family ID。

### 60 天

- V2 compiler 完成 shadow，逐模型族进入 5%→25% canary。
- 四个最小模型 family policy pack 可独立发布/回滚。
- 统一 token budget 与 compaction；长上下文、压缩和 injection 集进入发布门禁。
- telemetry/dashboard 可按 compiler、policy、model family 和 cohort 分层。

### 90 天

- 达到门禁的模型族推进 50%→100%，旧 compiler 进入保留期。
- runtime delta 稳定，完整 reminder fallback 率受控。
- 基于可信基线启动 P2 变体/路由实验，目标为成功率提升 ≥5 个百分点或质量非劣下显著降低单位成功成本。
- 发布 Prompt 版本治理、事故回滚和 policy owner 的常规流程。

## 11. 责任边界

| Owner | 责任 |
|---|---|
| Agent Runtime | IR、编译顺序、runtime snapshot/delta、项目规则、工具可见性 |
| LLM Runtime | 模型能力解析、wire role 映射、cache/reasoning/usage/provider 兼容 |
| Security/Runtime Policy | 权限 resolver、sandbox/gate、对抗集和硬违规定义 |
| Eval/DX | 任务 fixture、rubric、baseline、CI 报告与人工复核流程 |
| SRE/平台 | telemetry、dashboard、feature flag、canary、自动回滚与保留期 |

Prompt policy 的内容 owner 和运行时执行 owner 必须分离 review：文案不能改变硬权限，provider 兼容修改也不能绕过 Prompt 回归门禁。

## 12. 风险清单与决策记录

| 风险 | 缓解 |
|---|---|
| 类型化架构增加复杂度 | P0 先 shadow 包装现有输出，不立即重写；按 producer 渐进迁移 |
| 规则继承增加 token | token 化预算、来源诊断、按目录稳定合并；超限有明确原因 |
| 多模型 policy 分叉 | 只维护少量 family pack；未知模型使用 generic；每个差异必须有评测证据 |
| hash 泄漏低熵正文 | 使用环境级轮换 HMAC，不记录原文，不跨环境关联 |
| live eval 成本或凭据风险 | 显式 opt-in、受控连接、预算上限、无 CLI key、只保存脱敏指标 |
| shadow 双编译消耗 CPU | 采样、异步 manifest 比较、可独立关闭，不发送双 provider 请求 |
| 压缩遗漏关键约束 | reserved section、关键约束 recall、完整 reminder fallback、replay 测试 |
| provider role 差异造成行为漂移 | policy 明确 role strategy，wire contract test，模型族独立 canary |
| 远程模型目录改变行为 | 远程数据只提供能力；Prompt policy 必须来自本地版本化 allowlist |

已确定的架构决策：

1. 不以“统一重写一份更强系统提示词”为项目目标。
2. 不把安全交给 Prompt；服务端权限和模式状态始终是权威。
3. 不让 provider adapter 承载产品语义。
4. 不把远程 model catalog 当成可信 Prompt 来源。
5. 不用完整 Prompt 日志换取可观测性。
6. 不在同一实验中同时改变 compiler、policy 和模型版本。
7. 不在缺少行为基线时宣称 token 更少等于质量更好。

## 13. 完成定义

本方案后续实施完成的判定条件不是“新 Prompt 已上线”，而是：

- 每次请求都有可解释、无正文的 manifest 和明确 compiler/policy 版本。
- 权限、mode、Goal 和项目规则来源能够被确定性重建和测试。
- 稳定前缀、动态尾部、token 截断和 history anchor 变化均可归因。
- PR 有离线行为门禁，发布有按模型族的 live/canary 证据。
- 硬违规自动回滚；质量、延迟和单位成功成本满足非劣门槛。
- 旧编译器和兼容 snapshot 在保留期内能无损回退。

## 14. 本轮复核声明

- **文档交付**：仅新增 `docs/integration/synax-prompt-engineering-production-plan.md`，并链接现有 Codex 调研报告。
- **现状/建议边界**：本文所有尚未存在的接口、文件、feature flag、CI 和 dashboard 均标记为建议或“新增”，不作为当前能力陈述。
- **路径一致性**：现状证据均使用仓库相对路径；规划路径集中在 Agent Runtime、LLM Runtime、`evals/`、`scripts/` 和 `.github/workflows/` 边界内。
- **依赖一致性**：P0 正确性与 manifest 先行，P1 compiler/policy/budget 依赖 P0，P2 实验依赖 P1 可观测性和回滚。
- **验证限制**：本轮没有调用任何真实 provider，没有运行多模型 live eval，也没有测量真实 provider cache 命中、延迟或成本；这些必须在实施后的受控评测阶段完成。
