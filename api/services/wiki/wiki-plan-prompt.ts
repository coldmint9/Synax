import type { WikiEvaluation } from './wiki-evaluation-service.js'
import type { WikiBlock, WikiSourceBinding } from './contracts.js'
import { buildLanguageDirective } from '../prompts/language-directive.js'

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

  return [
    buildLanguageDirective(locale),
    buildPlanPromptCore(issueDetails, ctx.wikiOverview),
  ].join('\n');
}

function buildIssueDetails(ctx: PlanPromptContext): string {
  return ctx.issues.map((issue, i) => {
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
- **Content**: ${issue.content}
- **Related Block**: "${blockTitle}" (${blockType})
- **Block Summary**: ${blockContent}
- **Source Bindings**:
${relatedBindings || '    (no direct bindings)'}`;
  }).join('\n\n');
}

function buildPlanPromptCore(issueDetails: string, wikiOverview: string): string {
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
