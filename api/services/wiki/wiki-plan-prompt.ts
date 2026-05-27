import type { WikiEvaluation } from './wiki-evaluation-service.js'
import type { WikiBlock, WikiSourceBinding } from './contracts.js'

export interface PlanPromptContext {
  issues: WikiEvaluation[]
  blocks: Record<string, WikiBlock>
  bindings: WikiSourceBinding[]
  wikiOverview: string
}

export function buildPlanPrompt(ctx: PlanPromptContext): string {
  const issueDetails = ctx.issues.map((issue, i) => {
    const block = ctx.blocks[issue.blockId]
    const blockTitle = block ? extractBlockTitle(block) : issue.blockId.slice(0, 8)
    const blockType = block?.blockType ?? 'unknown'
    const blockContent = block ? extractContent(block) : '(unavailable)'

    const relatedBindings = ctx.bindings
      .filter(b => b.wikiBlockId === issue.blockId)
      .map(b => {
        const loc = b.filePath
          ? `${b.filePath}${b.startLine ? `:${b.startLine}-${b.endLine}` : ''}`
          : b.sourceId
        return `    - ${loc} (${b.sourceType}, confidence: ${b.confidence})`
      })
      .join('\n')

    return `### Issue ${i + 1}: [${issue.id}]
- **内容**: ${issue.content}
- **关联 Block**: "${blockTitle}" (${blockType})
- **Block 摘要**: ${blockContent}
- **源码绑定**:
${relatedBindings || '    (无直接绑定)'}`
  }).join('\n\n')

  return `你是一个软件架构规划师。你的任务是基于用户提出的 Issues 生成可执行的行动规划。

## Issues（一等公民）

以下每个 Issue 都需要你深入理解和澄清，不要跳过任何一个。

${issueDetails}

## 全局架构概览
${ctx.wikiOverview}

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

节点粒度：一个节点 = 一个可独立完成和验证的代码变更。`
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
