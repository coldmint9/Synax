import type { WikiEvaluation } from './wiki-evaluation-service.js'
import type { WikiBlock, WikiSourceBinding } from './contracts.js'

export interface PlanPromptContext {
  issues: WikiEvaluation[]
  blocks: Record<string, WikiBlock>
  bindings: WikiSourceBinding[]
  wikiOverview: string
}

export function buildPlanPrompt(ctx: PlanPromptContext): string {
  const issueList = ctx.issues.map((issue, i) => {
    const block = ctx.blocks[issue.blockId]
    const blockTitle = block ? extractBlockTitle(block) : issue.blockId.slice(0, 8)
    return `  ${i + 1}. [${issue.id}] "${issue.content}" (Block: ${blockTitle}, blockId: ${issue.blockId})`
  }).join('\n')

  const blockContents = Object.values(ctx.blocks)
    .filter(b => ctx.issues.some(e => e.blockId === b.id))
    .map(b => `### Block ${b.id} (${b.blockType})\n${extractContent(b)}`)
    .join('\n\n')

  const sourceSnippets = ctx.bindings.slice(0, 10).map(b => {
    const loc = b.filePath ? `${b.filePath}${b.startLine ? `:${b.startLine}-${b.endLine}` : ''}` : b.sourceId
    return `  - ${loc}`
  }).join('\n')

  return `你是一个软件架构规划师。基于用户对代码库设计文档提出的 Issues，生成一个可执行的行动规划。

## 全局架构概览
${ctx.wikiOverview}

## Issues 列表
${issueList}

## 关联 Block 内容
${blockContents}

## 相关源码文件
${sourceSnippets || '  (无直接绑定的源码)'}

## 指令
1. 分析所有 Issues，理解它们之间的关联和优先级
2. 如果需要更多源码上下文，使用 plan.read_source 工具读取相关文件
3. 将 Issues 分解为可执行的规划节点，每个节点是一个独立的、可验证的任务
4. 每个节点应包含：
   - title: 简短的行动标题
   - description: 具体需要做什么、为什么
   - evaluationIds: 关联的 Issue ID 列表
   - dependsOn: 依赖的其他节点标题列表（确保拓扑排序正确）
   - expectedFiles: 预期需要修改的文件路径列表
5. 节点粒度：一个节点 = 一个可独立完成和验证的代码变更
6. 最终使用 plan.submit_plan 工具提交规划`
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
    if (typeof content === 'string') return content.slice(0, 500)
    if (content?.text) return content.text.slice(0, 500)
    return JSON.stringify(content).slice(0, 500)
  } catch { /* ignore */ }
  return '(content unavailable)'
}
