import type { WikiGoal } from './wiki-goal-service.js'
import type { WikiDocument } from './contracts.js'
import { buildLanguageDirective } from '../prompts/language-directive.js'

export interface PlanPromptContext {
  goals: WikiGoal[]
  documents: Record<string, WikiDocument>
  wikiOverview: string
  locale?: 'zh' | 'en'
}

export function buildPlanPrompt(ctx: PlanPromptContext): string {
  const locale = ctx.locale ?? 'zh';
  const goalDetails = buildGoalDetails(ctx);

  return [
    buildLanguageDirective(locale),
    buildPlanPromptCore(goalDetails, ctx.wikiOverview),
  ].join('\n');
}

function buildGoalDetails(ctx: PlanPromptContext): string {
  return ctx.goals.map((goal, i) => {
    const doc = goal.documentId ? ctx.documents[goal.documentId] : null
    const docTitle = doc?.title ?? (goal.documentId ? goal.documentId.slice(0, 8) : 'Project-wide')
    const docExcerpt = doc?.contentMd ? doc.contentMd.slice(0, 800) : '(unavailable)'
    const anchor = goal.anchorJson
      ? `\n- **Anchor**: ${goal.anchorJson.type}${goal.anchorJson.heading ? ` §${goal.anchorJson.heading}` : ''}${goal.anchorJson.quote ? ` "${goal.anchorJson.quote.slice(0, 200)}"` : ''}`
      : ''

    const refs = doc?.references?.map(ref => {
      const loc = ref.startLine != null
        ? `${ref.filePath}:${ref.startLine}${ref.endLine != null ? `-${ref.endLine}` : ''}`
        : ref.filePath
      return `    - ${loc}${ref.symbol ? ` (${ref.symbol})` : ''}`
    }).join('\n') ?? '    (no references)'

    return `### Goal ${i + 1}: [${goal.id}]
- **Scope**: ${goal.scope}
- **Content**: ${goal.content}${anchor}
- **Related Document**: "${docTitle}"
- **Document Excerpt**: ${docExcerpt}
- **Source References**:
${refs}`;
  }).join('\n\n');
}

function buildPlanPromptCore(goalDetails: string, wikiOverview: string): string {
  return `You are a software architecture planner. Your task is to generate an executable action plan based on Goals raised by the user.

**Goal outcome**: code changes land in the workspace; Wiki sync happens after execution.

## Goals (first-class citizens)

Each Goal below requires your deep understanding. Do not skip any.

${goalDetails}

## Global Architecture Overview
${wikiOverview}

## Workflow (execute strictly in order)

### Phase 1 — Clarify Goals (must complete first)
Analyze each Goal one by one:
1. What exactly does this goal require? Are there implicit requirements?
2. Which modules/components are involved? What is the impact scope?
3. Are there dependencies or conflicts between other goals?
4. If document content is unclear, use plan.read_wiki_document for additional understanding

### Phase 2 — Search and Verify
Based on Phase 1 understanding and the source references listed above:
1. Use grep.search to search for key symbols, types, function names
2. Use file.read to read key code snippets when necessary (do not read entire files)
3. Verify that the problems described in goals actually exist in the code
4. Identify files that need modification and their dependencies

### Phase 3 — Submit Plan Nodes Incrementally
Decompose goals into executable plan nodes, **submit one at a time**:
- After designing each node, immediately use plan.submit_node
- Submit in dependency order: depended-upon nodes first
- Each node must include goalIds linking to the goals it addresses

Each node contains:
- title, description, goalIds, dependsOn (titles), expectedFiles`;
}
