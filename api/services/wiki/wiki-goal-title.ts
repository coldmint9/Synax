import { agentRuntimeStore } from '../agent-runtime/session-store.js'
import type { TitleGenerator, TitleGeneratorContext } from '../agent-runtime/session-title-service.js'
import { generateGatewayTextResult } from '../llm-runtime/gateway.js'

export function extractUserGoalFromPrompt(prompt: string): string | null {
  const marker = '## User Goal'
  const idx = prompt.indexOf(marker)
  if (idx === -1) return null
  const after = prompt.slice(idx + marker.length)
  const nextSection = after.search(/\n## /)
  const block = (nextSection === -1 ? after : after.slice(0, nextSection)).trim()
  return block || null
}

export function extractPlanNodeTitleFromPrompt(prompt: string): string | null {
  const match = prompt.match(/- \*\*Title\*\*: (.+)/)
  return match?.[1]?.trim() || null
}

export function resolveGoalTitleSource(input: {
  sessionMetadata: Record<string, unknown> | null
  prompt: string
}): string | null {
  const meta = input.sessionMetadata
  if (meta) {
    const goalContent = meta.goalContent
    if (typeof goalContent === 'string' && goalContent.trim()) {
      return goalContent.trim()
    }
    const planNodeTitle = meta.planNodeTitle
    if (typeof planNodeTitle === 'string' && planNodeTitle.trim()) {
      return planNodeTitle.trim()
    }
  }

  return extractUserGoalFromPrompt(input.prompt)
    ?? extractPlanNodeTitleFromPrompt(input.prompt)
}

async function generateGoalTitleWithLlm(projectId: string, task: string): Promise<string | null> {
  const truncated = task.slice(0, 300)
  const result = await generateGatewayTextResult({
    projectId,
    purpose: 'session-title',
    messages: [{
      role: 'user',
      content: [
        'Generate a short title (max 10 Chinese characters or 6 English words) for this coding goal.',
        'Return ONLY the title, no quotes or punctuation.',
        '',
        `Goal: ${truncated}`,
      ].join('\n'),
    }],
    maxTokens: 30,
    temperature: 0.3,
  })

  const title = (result.text ?? '').trim().slice(0, 50)
  return title || null
}

export const goalTitleGenerator: TitleGenerator = {
  generate(ctx: TitleGeneratorContext) {
    const session = agentRuntimeStore.tryGetSession(ctx.sessionId)
    const source = resolveGoalTitleSource({
      sessionMetadata: session?.sessionMetadata ?? null,
      prompt: ctx.prompt,
    })
    if (!source) return null
    return generateGoalTitleWithLlm(ctx.projectId, source)
  },
}
