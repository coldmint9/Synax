import { generateGatewayTextResult } from '../llm-runtime/gateway.js'

export async function maybeGenerateStructuredText(
  purpose: 'context-signal' | 'wiki',
  projectId: string,
  system: string,
  user: string,
  model?: string,
): Promise<string | null> {
  try {
    const result = await generateGatewayTextResult({
      projectId,
      purpose,
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      maxTokens: 4096,
    })
    return result.text || null
  } catch {
    return null
  }
}

export function extractJsonObject(text: string): unknown | null {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fenced?.[1], trimmed]
  for (const candidate of candidates) {
    if (!candidate) continue
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    const slice = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate
    try {
      return JSON.parse(slice)
    } catch {
      continue
    }
  }
  return null
}
