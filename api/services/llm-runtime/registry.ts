import { logger } from '../../lib/logger.js'
import type { ResolvedProviderConfig, RuntimeProvider } from './types.js'

type ProviderFactory = any

const REGISTRY: Record<string, () => Promise<ProviderFactory>> = {
  '@ai-sdk/anthropic': async () => (await import('@ai-sdk/anthropic')).createAnthropic,
  '@ai-sdk/cerebras': async () => (await import('@ai-sdk/cerebras')).createCerebras,
  '@ai-sdk/cohere': async () => (await import('@ai-sdk/cohere')).createCohere,
  '@ai-sdk/deepinfra': async () => (await import('@ai-sdk/deepinfra')).createDeepInfra,
  '@ai-sdk/deepseek': async () => (await import('@ai-sdk/deepseek')).createDeepSeek,
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
    async pull(controller) {
      // Handled in start
    },
    async start(controller) {
      const reader = body.getReader()
      let buffer = ''
      // Per-index state: track whether we've seen id/name
      const indexState = new Map<number, { id?: string; name?: string; pending: string[] }>()
      const MAX_PENDING = 5

      function flushIndex(index: number) {
        const state = indexState.get(index)
        if (!state || state.pending.length === 0) return
        const id = state.id ?? `call_${index}_${Math.random().toString(36).slice(2, 10)}`
        for (let i = 0; i < state.pending.length; i++) {
          const line = state.pending[i]
          if (i === 0) {
            // Patch the first chunk with id and name
            try {
              const trimmed = line.trimEnd()
              const suffix = line.slice(trimmed.length)
              const payload = trimmed.slice(6)
              const data = JSON.parse(payload)
              for (const choice of data?.choices ?? []) {
                for (const tc of choice?.delta?.tool_calls ?? []) {
                  if (tc.index === index) {
                    if (!tc.id) tc.id = id
                    if (!tc.function) tc.function = {}
                    if (!tc.function.name && state.name) tc.function.name = state.name
                  }
                }
              }
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}${suffix}`))
            } catch { controller.enqueue(encoder.encode(line)) }
          } else {
            controller.enqueue(encoder.encode(line))
          }
        }
        state.pending = []
      }

      function processLine(line: string) {
        const trimmed = line.trimEnd()
        if (!trimmed.startsWith('data: ')) {
          controller.enqueue(encoder.encode(line))
          return
        }
        const payload = trimmed.slice(6)
        if (payload === '[DONE]') {
          // Flush all pending before DONE
          for (const [idx] of indexState) flushIndex(idx)
          controller.enqueue(encoder.encode(line))
          return
        }

        let hasToolCalls = false
        let needsBuffering = false
        try {
          const data = JSON.parse(payload)
          for (const choice of data?.choices ?? []) {
            for (const tc of choice?.delta?.tool_calls ?? []) {
              const idx = tc.index
              if (typeof idx !== 'number') continue
              hasToolCalls = true

              if (!indexState.has(idx)) {
                indexState.set(idx, { pending: [] })
              }
              const state = indexState.get(idx)!

              if (typeof tc.id === 'string' && tc.id) state.id = tc.id
              if (typeof tc.function?.name === 'string' && tc.function.name) state.name = tc.function.name

              if (!state.id) {
                needsBuffering = true
              }
            }
          }
        } catch {
          controller.enqueue(encoder.encode(line))
          return
        }

        if (!hasToolCalls) {
          controller.enqueue(encoder.encode(line))
          return
        }

        if (needsBuffering) {
          // Buffer this line for indices missing id
          for (const [idx, state] of indexState) {
            if (!state.id) {
              state.pending.push(line)
              if (state.pending.length >= MAX_PENDING) flushIndex(idx)
              break
            }
          }
        } else {
          // All indices have id — flush any pending and pass through
          for (const [idx, state] of indexState) {
            if (state.pending.length > 0) flushIndex(idx)
          }
          controller.enqueue(encoder.encode(line))
        }
      }

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            if (buffer) processLine(buffer)
            for (const [idx] of indexState) flushIndex(idx)
            break
          }
          buffer += decoder.decode(value, { stream: true })
          const parts = buffer.split('\n')
          buffer = parts.pop() ?? ''
          for (const part of parts) processLine(part + '\n')
        }
      } catch (err) {
        controller.error(err)
        return
      }

      controller.close()
    },
  })
}
