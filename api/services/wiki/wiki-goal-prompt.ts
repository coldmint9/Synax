import type { GoalAnchor, WikiGoal } from './wiki-goal-service.js'
import { buildLanguageDirective } from '../prompts/language-directive.js'

export type GoalPromptMode = 'direct' | 'plan_node'

export type GoalPlanNodeContext = {
  title: string
  description: string
  expectedFiles: string[]
  dependsOn: string[]
}

export type GoalCompletedNodeContext = {
  title: string
  summary?: string
}

export function buildGoalSessionPrompt(input: {
  mode?: GoalPromptMode
  content: string
  documentTitle?: string | null
  documentId?: string | null
  anchorJson?: GoalAnchor | null
  node?: GoalPlanNodeContext
  linkedGoals?: WikiGoal[]
  completedNodes?: GoalCompletedNodeContext[]
  redoFeedback?: string
  locale?: 'zh' | 'en'
}): string {
  const mode = input.mode ?? 'direct'
  const locale = input.locale ?? 'zh'

  if (mode === 'plan_node') {
    return buildPlanNodePrompt(input, locale)
  }
  return buildDirectPrompt(input, locale)
}

function buildDirectPrompt(
  input: {
    content: string
    documentTitle?: string | null
    documentId?: string | null
    anchorJson?: GoalAnchor | null
  },
  locale: 'zh' | 'en',
): string {
  const lines: string[] = [
    buildLanguageDirective(locale),
    '',
    '## User Goal',
    input.content.trim(),
  ]

  if (input.documentId || input.documentTitle) {
    lines.push('', '## Wiki Context')
    if (input.documentTitle) lines.push(`- Document: ${input.documentTitle}`)
    if (input.documentId) lines.push(`- Document ID: ${input.documentId}`)
    if (input.anchorJson) {
      appendAnchorLines(lines, input.anchorJson)
    }
    lines.push('- Keep wiki documentation aligned when you change related code.')
  }

  lines.push(
    '',
    '## Instructions',
    '- Investigate the codebase, implement the goal, and verify your changes.',
    '- Prefer minimal, focused diffs. Explain blockers clearly if you cannot finish.',
  )

  return lines.join('\n')
}

function buildPlanNodePrompt(
  input: {
    content: string
    node?: GoalPlanNodeContext
    linkedGoals?: WikiGoal[]
    completedNodes?: GoalCompletedNodeContext[]
    redoFeedback?: string
  },
  locale: 'zh' | 'en',
): string {
  const node = input.node
  const goalDetails = (input.linkedGoals ?? []).map((g, i) => {
    const anchor = g.anchorJson
      ? `\n- Anchor: ${g.anchorJson.type}${g.anchorJson.heading ? ` §${g.anchorJson.heading}` : ''}${g.anchorJson.quote ? ` "${g.anchorJson.quote.slice(0, 120)}"` : ''}`
      : ''
    return `### Goal ${i + 1} [${g.id}]
- Content: ${g.content}
- Scope: ${g.scope}${anchor}`
  }).join('\n\n')

  const files = node && node.expectedFiles.length > 0
    ? node.expectedFiles.map(f => `- ${f}`).join('\n')
    : '- (infer from description)'

  const completed = (input.completedNodes ?? []).length > 0
    ? input.completedNodes!.map(n => `- ${n.title}${n.summary ? `: ${n.summary}` : ''}`).join('\n')
    : '- (none)'

  const feedbackBlock = input.redoFeedback
    ? `\n## Redo Feedback\n${input.redoFeedback}\n`
    : ''

  return [
    buildLanguageDirective(locale),
    'You are a Goal Agent executing a single plan node. Implement the node by making real code changes in the workspace.',
    '',
    '## Plan Node',
    `- **Title**: ${node?.title ?? input.content}`,
    `- **Description**: ${node?.description ?? input.content}`,
    '',
    '## Linked Goals',
    goalDetails || '(none)',
    '',
    '## Completed Dependencies',
    completed,
    '',
    '## Expected Files (write scope)',
    files,
    feedbackBlock,
    '## Rules',
    '1. Read relevant code with grep.search and file.read before writing.',
    '2. Use file.patch for targeted edits; file.write only for new files.',
    '3. Prefer expected files; explain clearly if you must go outside that scope.',
    '4. Do not update wiki documentation — wiki refresh runs after the full plan completes.',
    '5. You may use shell to run tests and verify changes.',
    '6. End with a structured summary: what changed and how to verify.',
  ].join('\n')
}

function appendAnchorLines(lines: string[], anchor: GoalAnchor): void {
  if (anchor.type === 'heading' && anchor.heading) {
    lines.push(`- Anchor heading: ${anchor.heading}`)
  }
  if (anchor.quote) {
    lines.push(`- Selected quote: "${anchor.quote.slice(0, 300)}"`)
  }
}
