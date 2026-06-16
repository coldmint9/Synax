import type { WikiGoal, WikiPlanNode } from './wiki-goal-service.js'
import { buildLanguageDirective } from '../prompts/language-directive.js'

export function buildPlanExecutorPrompt(
  node: WikiPlanNode,
  goals: WikiGoal[],
  feedback?: string,
  locale: 'zh' | 'en' = 'zh',
): string {
  const goalDetails = goals.map((g, i) => {
    const anchor = g.anchorJson
      ? `\n- Anchor: ${g.anchorJson.type}${g.anchorJson.heading ? ` §${g.anchorJson.heading}` : ''}${g.anchorJson.quote ? ` "${g.anchorJson.quote.slice(0, 120)}"` : ''}`
      : ''
    return `### Goal ${i + 1} [${g.id}]
- Content: ${g.content}
- Scope: ${g.scope}${anchor}`
  }).join('\n\n')

  const files = node.expectedFiles.length > 0
    ? node.expectedFiles.map(f => `- ${f}`).join('\n')
    : '- (infer from description)'

  const feedbackBlock = feedback
    ? `\n## Redo Feedback\n${feedback}\n`
    : ''

  return [
    buildLanguageDirective(locale),
    `You are a plan executor agent. Implement the following plan node by making real code changes in the workspace.

## Plan Node
- **Title**: ${node.title}
- **Description**: ${node.description}

## Linked Goals
${goalDetails || '(none)'}

## Expected Files (write scope)
${files}
${feedbackBlock}
## Rules
1. Read relevant code with grep.search and file.read before writing.
2. Use file.patch for targeted edits; file.write only for new files.
3. Stay within expected files unless strictly necessary.
4. Goal outcome is **code landing** — do not update wiki docs.
5. Summarize changes when done.`,
  ].join('\n')
}
