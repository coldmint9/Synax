import type { WikiEvaluation } from './wiki-evaluation-service.js'
import type { WikiDocument } from './contracts.js'
import { buildLanguageDirective } from '../prompts/language-directive.js'

export interface PlanPromptContext {
  issues: WikiEvaluation[]
  documents: Record<string, WikiDocument>
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
    const doc = ctx.documents[issue.documentId]
    const docTitle = doc?.title ?? issue.documentId.slice(0, 8)
    const docExcerpt = doc?.contentMd ? doc.contentMd.slice(0, 800) : '(unavailable)'

    const refs = doc?.references?.map(ref => {
      const loc = ref.startLine != null
        ? `${ref.filePath}:${ref.startLine}${ref.endLine != null ? `-${ref.endLine}` : ''}`
        : ref.filePath
      return `    - ${loc}${ref.symbol ? ` (${ref.symbol})` : ''}`
    }).join('\n') ?? '    (no references)'

    return `### Issue ${i + 1}: [${issue.id}]
- **Content**: ${issue.content}
- **Related Document**: "${docTitle}"
- **Document Excerpt**: ${docExcerpt}
- **Source References**:
${refs}`;
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
4. If document content is unclear, use plan.read_wiki_document for additional understanding

In your thinking, output the clarification analysis for each issue before proceeding.

### Phase 2 — Search and Verify
Based on Phase 1 understanding and the source references listed above:
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
