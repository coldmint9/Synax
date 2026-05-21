import { generateText } from 'ai'
import { resolveGatewaySelection } from '../llm-runtime/stream.js'
import { instantiateProvider, selectLanguageModel } from '../llm-runtime/registry.js'

export async function maybeGenerateStructuredText(
  purpose: 'context-signal' | 'wiki',
  projectId: string,
  system: string,
  user: string,
  model?: string,
): Promise<string | null> {
  try {
    const selection = await resolveGatewaySelection({ projectId, purpose, model })
    if (!selection) return null
    const client = await instantiateProvider(selection.provider, selection.config)
    const languageModel = selectLanguageModel(client, selection.modelId)
    const response = await generateText({
      model: languageModel as never,
      system,
      messages: [{ role: 'user', content: user }],
      temperature: 0.2,
      maxOutputTokens: 4096,
    })
    return response.text || null
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
