import type { WikiEvaluation } from './wiki-evaluation-service.js'
import type { WikiBlock, WikiSourceBinding } from './contracts.js'

export interface PlanPromptContext {
  issues: WikiEvaluation[]
  blocks: Record<string, WikiBlock>
  bindings: WikiSourceBinding[]
  wikiOverview: string
  locale?: 'zh' | 'en'
}

export function buildPlanPrompt(ctx: PlanPromptContext): string {
  const locale = ctx.locale ?? 'zh';
  const issueDetails = buildIssueDetails(ctx);

  if (locale === 'en') return buildPlanPromptEn(issueDetails, ctx.wikiOverview);
  return buildPlanPromptZh(issueDetails, ctx.wikiOverview);
}

function buildIssueDetails(ctx: PlanPromptContext): string {
  const locale = ctx.locale ?? 'zh';
  return ctx.issues.map((issue, i) => {
    const block = ctx.blocks[issue.blockId]
    const blockTitle = block ? extractBlockTitle(block) : issue.blockId.slice(0, 8)
    const blockType = block?.blockType ?? 'unknown'
    const blockContent = block ? extractContent(block) : locale === 'en' ? '(unavailable)' : '(unavailable)'

    const relatedBindings = ctx.bindings
      .filter(b => b.wikiBlockId === issue.blockId)
      .map(b => {
        const loc = b.filePath
          ? `${b.filePath}${b.startLine ? `:${b.startLine}-${b.endLine}` : ''}`
          : b.sourceId
        return `    - ${loc} (${b.sourceType}, confidence: ${b.confidence})`
      })
      .join('\n')

    if (locale === 'en') {
      return `### Issue ${i + 1}: [${issue.id}]
- **Content**: ${issue.content}
- **Related Block**: "${blockTitle}" (${blockType})
- **Block Summary**: ${blockContent}
- **Source Bindings**:
${relatedBindings || '    (no direct bindings)'}`;
    }

    return `### Issue ${i + 1}: [${issue.id}]
- **内容**: ${issue.content}
- **关联 Block**: "${blockTitle}" (${blockType})
- **Block 摘要**: ${blockContent}
- **源码绑定**:
${relatedBindings || '    (无直接绑定)'}`;
  }).join('\n\n');
}

function buildPlanPromptEn(issueDetails: string, wikiOverview: string): string {
  return `You are a software architecture planner. Your task is to generate an executable action plan based on the Issues raised by the user.

## Issues (first-class citizens)

Each Issue below requires your deep understanding and clarification. Do not skip any.

${issueDetails}

## Global Architecture Overview
${wikiOverview}

## Workflow (execute strictly in order)

### Phase 1 — Clarify Issues (must complete first)
Analyze each Issue one by one:
1. What exactly does this issue require? Are there implicit requirements?
2. Which modules/components are involved? What is the impact scope?
3. Are there dependencies or conflicts with other issues?
4. If block content is unclear, use plan.read_wiki_block for additional understanding

In your thinking, output the clarification analysis for each issue before proceeding.

### Phase 2 — Search and Verify
Based on Phase 1 understanding and the source binding clues listed above:
1. Use grep.search to search for key symbols, types, function names to understand code structure
2. Use file.read to read key code snippets when necessary (do not read entire files)
3. Verify that the problems described in issues actually exist in the code
4. Identify files that need modification and their dependencies

### Phase 3 — Submit Plan Nodes Incrementally
Decompose issues into executable plan nodes, **submit one at a time**:
- After designing each node, immediately use the plan.submit_node tool to submit
- Submit in dependency order: depended-upon nodes first, dependent nodes later
- Do not wait until all nodes are designed to submit them all at once

Each node contains:
- title: Short action title (globally unique, subsequent nodes reference dependencies by this title)
- description: What specifically needs to be done, why, and how to verify
- evaluationIds: List of associated Issue IDs
- dependsOn: List of other node titles this depends on (must be titles of already-submitted nodes)
- expectedFiles: List of file paths expected to be modified

Node granularity: one node = one independently completable and verifiable code change.`;
}

function buildPlanPromptZh(issueDetails: string, wikiOverview: string): string {
  return `你是一个软件架构规划师。你的任务是基于用户提出的 Issues 生成可执行的行动规划。

## Issues（一等公民）

以下每个 Issue 都需要你深入理解和澄清，不要跳过任何一个。

${issueDetails}

## 全局架构概览
${wikiOverview}

## 工作流程（严格按序执行）

### Phase 1 — 澄清 Issues（必须先完成）
逐个分析每个 Issue：
1. 这个 issue 具体要求什么？有没有隐含的需求？
2. 涉及哪些模块/组件？影响范围多大？
3. 与其他 issues 有没有依赖或冲突关系？
4. 如果 block 内容不够清晰，用 plan.read_wiki_block 补充理解

在你的思考中，先输出每个 issue 的澄清分析，再进入下一步。

### Phase 2 — 搜索验证
基于 Phase 1 的理解和上面列出的源码绑定线索：
1. 用 grep.search 搜索关键符号、类型、函数名来理解代码结构
2. 必要时用 file.read 精读关键代码片段（不要整文件读取）
3. 验证 issue 描述的问题在代码中确实存在
4. 识别需要修改的文件和依赖关系

### Phase 3 — 逐步提交规划节点
将 issues 分解为可执行的规划节点，**逐个提交**：
- 每完成一个节点的设计，立即使用 plan.submit_node 工具提交
- 按依赖顺序提交：被依赖的节点先提交，依赖其他节点的后提交
- 不要等所有节点设计完再一起提交

每个节点包含：
- title: 简短的行动标题（全局唯一，后续节点通过此标题引用依赖）
- description: 具体需要做什么、为什么、怎么验证
- evaluationIds: 关联的 Issue ID 列表
- dependsOn: 依赖的其他节点标题列表（必须是已提交节点的标题）
- expectedFiles: 预期需要修改的文件路径列表

节点粒度：一个节点 = 一个可独立完成和验证的代码变更。`;
}

function extractBlockTitle(block: WikiBlock): string {
  try {
    const content = typeof block.content === 'string' ? JSON.parse(block.content) : block.content
    if (content?.title) return content.title
    if (content?.text) return content.text.slice(0, 40)
    if (typeof content === 'string') return content.slice(0, 40)
  } catch { /* ignore */ }
  return block.blockType
}

function extractContent(block: WikiBlock): string {
  try {
    const content = typeof block.content === 'string' ? JSON.parse(block.content) : block.content
    if (typeof content === 'string') return content.slice(0, 800)
    if (content?.text) return content.text.slice(0, 800)
    return JSON.stringify(content).slice(0, 800)
  } catch { /* ignore */ }
  return '(content unavailable)'
}
