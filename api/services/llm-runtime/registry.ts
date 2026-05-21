import { logger } from '../../lib/logger.js'
import type { ResolvedProviderConfig, RuntimeProvider } from './types.js'

type ProviderFactory = any

const REGISTRY: Record<string, () => Promise<ProviderFactory>> = {
  '@ai-sdk/anthropic': async () => (await import('@ai-sdk/anthropic')).createAnthropic,
  '@ai-sdk/cerebras': async () => (await import('@ai-sdk/cerebras')).createCerebras,
  '@ai-sdk/cohere': async () => (await import('@ai-sdk/cohere')).createCohere,
  '@ai-sdk/deepinfra': async () => (await import('@ai-sdk/deepinfra')).createDeepInfra,
  '@ai-sdk/google': async () => (await import('@ai-sdk/google')).createGoogleGenerativeAI,
  '@ai-sdk/groq': async () => (await import('@ai-sdk/groq')).createGroq,
  '@ai-sdk/mistral': async () => (await import('@ai-sdk/mistral')).createMistral,
  '@ai-sdk/openai': async () => (await import('@ai-sdk/openai')).createOpenAI,
  '@ai-sdk/openai-compatible': async () => (await import('@ai-sdk/openai-compatible')).createOpenAICompatible,
  '@ai-sdk/perplexity': async () => (await import('@ai-sdk/perplexity')).createPerplexity,
  '@ai-sdk/togetherai': async () => (await import('@ai-sdk/togetherai')).createTogetherAI,
  '@ai-sdk/xai': async () => (await import('@ai-sdk/xai')).createXai,
  '@openrouter/ai-sdk-provider': async () => (await import('@openrouter/ai-sdk-provider')).createOpenRouter,
}

export function isProviderSupported(provider: Pick<RuntimeProvider, 'npm'>): boolean {
  return Boolean(provider.npm && REGISTRY[provider.npm])
}

export async function instantiateProvider(
  provider: Pick<RuntimeProvider, 'id' | 'label' | 'npm' | 'api'>,
  config: ResolvedProviderConfig,
): Promise<unknown> {
  if (!provider.npm || !REGISTRY[provider.npm]) {
    throw new Error(`Provider '${provider.id}' is unsupported in Synapse runtime`)
  }

  const create = await REGISTRY[provider.npm]()
  const headers = normalizeStringMap(config.options?.headers)
  const options = normalizeObject(config.options)
  const baseURL = config.baseUrl ?? provider.api

  if (provider.npm === '@ai-sdk/openai-compatible') {
    const baseFetch = typeof options.fetch === 'function' ? (options.fetch as typeof globalThis.fetch) : undefined
    return create({
      name: provider.id,
      baseURL: baseURL ?? 'https://api.openai.com/v1',
      apiKey: config.apiKey,
      headers,
      ...options,
      fetch: createToolCallIdPatchFetch(baseFetch),
    })
  }

  if (provider.npm === '@openrouter/ai-sdk-provider') {
    return create({
      baseURL,
      apiKey: config.apiKey,
      headers,
      ...options,
    })
  }

  return create({
    ...(baseURL ? { baseURL } : {}),
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...options,
  })
}

export function selectLanguageModel(client: any, modelId: string, modelOptions?: Record<string, unknown>): unknown {
  if (!client) throw new Error('Provider client was not created')
  if (typeof client === 'function') return client(modelId, modelOptions)
  if (typeof client.responses === 'function') return client.responses(modelId, modelOptions)
  if (typeof client.messages === 'function') return client.messages(modelId, modelOptions)
  if (typeof client.chat === 'function') return client.chat(modelId, modelOptions)
  if (typeof client.languageModel === 'function') return client.languageModel(modelId, modelOptions)
  logger.warn({ modelId }, '[llm-runtime] provider client has no language model selector')
  throw new Error(`Provider client cannot resolve model '${modelId}'`)
}

function normalizeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
}

function normalizeStringMap(value: unknown): Record<string, string> {
  const input = normalizeObject(value)
  return Object.fromEntries(
    Object.entries(input)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0),
  )
}

function createToolCallIdPatchFetch(baseFetch?: typeof globalThis.fetch): typeof globalThis.fetch {
  const underlying = baseFetch ?? globalThis.fetch
  return async (input, init) => {
    const response = await underlying(input, init)
    if (!response.body) return response
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) return response
    return new Response(patchToolCallIdStream(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}

function patchToolCallIdStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()

  return new ReadableStream({
    async start(controller) {
      const reader = body.getReader()
      const lines: string[] = []
      let buffer = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            if (buffer) lines.push(buffer)
            break
          }
          buffer += decoder.decode(value, { stream: true })
          const parts = buffer.split('\n')
          buffer = parts.pop() ?? ''
          for (const part of parts) lines.push(part + '\n')
        }
      } catch (err) {
        controller.error(err)
        return
      }

      // First pass: collect tool call names and ids per index
      const toolCallNames = new Map<number, string>()
      const toolCallIds = new Map<number, string>()
      const allIndices = new Set<number>()
      for (const line of lines) {
        const trimmed = line.trimEnd()
        if (!trimmed.startsWith('data: ')) continue
        const payload = trimmed.slice(6)
        if (payload === '[DONE]') continue
        try {
          const data = JSON.parse(payload)
          for (const choice of data?.choices ?? []) {
            for (const tc of choice?.delta?.tool_calls ?? []) {
              const { index } = tc
              if (typeof index !== 'number') continue
              allIndices.add(index)
              if (typeof tc.id === 'string' && tc.id && !toolCallIds.has(index)) toolCallIds.set(index, tc.id)
              if (typeof tc.function?.name === 'string' && tc.function.name && !toolCallNames.has(index)) toolCallNames.set(index, tc.function.name)
            }
          }
        } catch {}
      }
      // Some providers omit function.name for parallel tool call indices — fill in from any known name
      if (toolCallNames.size > 0) {
        const fallbackName = toolCallNames.values().next().value as string
        for (const idx of allIndices) {
          if (!toolCallNames.has(idx)) toolCallNames.set(idx, fallbackName)
        }
      }

      // Second pass: emit with injected id/name for first chunk of each index
      const seenIndices = new Set<number>()
      for (const line of lines) {
        const trimmed = line.trimEnd()
        const suffix = line.slice(trimmed.length)
        if (!trimmed.startsWith('data: ')) { controller.enqueue(encoder.encode(line)); continue }
        const payload = trimmed.slice(6)
        if (payload === '[DONE]') { controller.enqueue(encoder.encode(line)); continue }
        try {
          const data = JSON.parse(payload)
          let patched = false
          for (const choice of data?.choices ?? []) {
            for (const tc of choice?.delta?.tool_calls ?? []) {
              const { index } = tc
              if (typeof index !== 'number') continue
              if (!seenIndices.has(index)) {
                seenIndices.add(index)
                if (!tc.id) {
                  tc.id = toolCallIds.get(index) ?? `call_${index}_${Math.random().toString(36).slice(2, 10)}`
                  patched = true
                }
                if (!tc.function) tc.function = {}
                if (!tc.function.name) {
                  const name = toolCallNames.get(index)
                  if (name) { tc.function.name = name; patched = true }
                }
              }
            }
          }
          controller.enqueue(encoder.encode(patched ? `data: ${JSON.stringify(data)}${suffix}` : line))
        } catch { controller.enqueue(encoder.encode(line)) }
      }

      controller.close()
    },
  })
}
