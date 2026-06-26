import { useMemo } from 'react'
import type { AgentSession } from '../../../lib/api/agentRuntime'

export const SESSION_DISPLAY_TITLE_MAX = 80

function looksLikeSystemPrompt(prompt: string): boolean {
  return prompt.includes('## ') || /^You are\b/m.test(prompt)
}

function truncateDisplayTitle(text: string, max = SESSION_DISPLAY_TITLE_MAX): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max - 1)}…`
}

export function resolveSessionUserInput(session: AgentSession): string | null {
  const goalContent = session.sessionMetadata?.goalContent
  if (typeof goalContent === 'string' && goalContent.trim()) {
    return goalContent.trim()
  }
  const planNodeTitle = session.sessionMetadata?.planNodeTitle
  if (typeof planNodeTitle === 'string' && planNodeTitle.trim()) {
    return planNodeTitle.trim()
  }
  return null
}

export function getSessionDisplayTitle(
  session: AgentSession,
  fallback = '',
): string {
  const title = session.title?.trim()
  if (title) return title

  const userInput = resolveSessionUserInput(session)
  if (userInput) return truncateDisplayTitle(userInput)

  const prompt = session.prompt.trim()
  if (prompt && prompt.length <= 120 && !looksLikeSystemPrompt(prompt)) {
    return truncateDisplayTitle(prompt)
  }
  if (prompt) return prompt.slice(0, 50)
  return fallback
}

export function useSessionDisplayTitle(
  session: AgentSession | null | undefined,
  fallback = '',
): string {
  return useMemo(
    () => (session ? getSessionDisplayTitle(session, fallback) : fallback),
    [session, fallback, session?.title, session?.prompt, session?.sessionMetadata?.goalContent, session?.sessionMetadata?.planNodeTitle],
  )
}
