import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { generateText, jsonSchema, streamText, tool } from 'ai'
import type { ToolSet } from 'ai'
import { afterEach, describe, expect, it } from 'vitest'
import { executePipeline } from '../pipeline.js'
import { applyJsonSchemaCompatMiddleware } from '../middleware/json-schema-compat.js'
import { buildProtocolProviderOptions } from '../protocol-options.js'
import { instantiateProvider, selectLanguageModel } from '../providers/provider-registry.js'
import { buildThinkingStreamOptions } from '../thinking-mode-strategy.js'
import type { LlmGatewayRequest, ResolvedModelSelection } from '../types.js'

const servers: http.Server[] = []
const warnings: string[] = []
process.on('warning', (w) => warnings.push(String(w.message)))

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve())
  })))
})

async function startStubServer(): Promise<{ baseUrl: string; bodies: Array<Record<string, unknown>> }> {
  const bodies: Array<Record<string, unknown>> = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      bodies.push(raw ? JSON.parse(raw) as Record<string, unknown> : {})
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(responsesPayload()))
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${port}/v1`, bodies }
}

function responsesPayload() {
  return {
    id: 'resp_test',
    object: 'response',
    created_at: 1_700_000_000,
    status: 'completed',
    model: 'deepseek-v4-flash',
    output: [
      {
        type: 'message',
        id: 'msg_test',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'pong', annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 3,
      output_tokens: 2,
      total_tokens: 5,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  }
}

/**
 * Mirrors a DeepSeek gateway connection resolved to the Open Responses
 * adapter with `apiFormat: 'openai-responses'`.
 */
function deepSeekResponsesSelection(baseUrl: string, overrides?: {
  reasoning?: boolean
}): ResolvedModelSelection {
  return {
    model: 'custom-api:deepseek/deepseek-v4-flash',
    providerId: 'custom-api:deepseek',
    modelId: 'deepseek-v4-flash',
    apiFormat: 'openai-responses',
    provider: {
      id: 'custom-api:deepseek',
      label: 'DeepSeek',
      npm: '@ai-sdk/open-responses',
      env: [],
      supported: true,
      models: [],
    },
    modelDef: { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash', ...(overrides?.reasoning != null ? { reasoning: overrides.reasoning } : {}) },
    config: { providerId: 'custom-api:deepseek', apiFormat: 'openai-responses', baseUrl, apiKey: 'sk-test' },
  }
}

function requestWith(overrides?: { reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; temperature?: number }): LlmGatewayRequest {
  return {
    purpose: 'agent',
    projectId: 'test-project',
    messages: [{ role: 'user', content: 'ping' }],
    model: null,
    maxTokens: 100,
    ...(overrides?.reasoningEffort ? { reasoningEffort: overrides.reasoningEffort } : {}),
    ...(overrides?.temperature != null ? { temperature: overrides.temperature } : {}),
  } as unknown as LlmGatewayRequest
}

/** Tool schema embedding `propertyNames`, as `z.record` conversions produce. */
function toolsWithPropertyNames(): ToolSet {
  return {
    lookup: tool({
      description: 'lookup tool',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          metadata: {
            type: 'object',
            additionalProperties: { type: 'string' },
            propertyNames: { type: 'string' },
          },
        },
        required: [],
        additionalProperties: false,
      }),
      execute: async () => 'ok',
    }),
  }
}

function emittedWarningsSince(count: number): string[] {
  return warnings.slice(count).filter(message => message.includes('AI SDK Warning'))
}

describe('OpenAI Responses wire warnings for DeepSeek gateway models', () => {
  it('strips propertyNames before the provider sees the schema', async () => {
    const { baseUrl } = await startStubServer()
    const client = await instantiateProvider(
      {
        id: 'custom-api:deepseek',
        label: 'DeepSeek',
        npm: '@ai-sdk/open-responses',
        api: undefined,
      },
      {
        providerId: 'custom-api:deepseek',
        apiFormat: 'openai-responses',
        baseUrl,
        apiKey: 'sk-test',
      },
    )
    const raw = selectLanguageModel(client, 'deepseek-v4-flash', undefined, 'openai-responses')
    const wrapped = applyJsonSchemaCompatMiddleware(raw as never)

    const before = warnings.length
    await streamText({
      model: wrapped,
      messages: [{ role: 'user', content: 'ping' }],
      tools: toolsWithPropertyNames(),
      maxRetries: 0,
    }).consumeStream()

    expect(emittedWarningsSince(before).filter(message => message.includes('propertyNames'))).toEqual([])
  })

  it('sends no AI SDK warnings and a clean body for a non-reasoning deepseek model', async () => {
    const { baseUrl, bodies } = await startStubServer()
    const selection = deepSeekResponsesSelection(baseUrl)
    const before = warnings.length

    const result = await executePipeline(
      requestWith({ reasoningEffort: 'high' }),
      selection,
      { kind: 'stream', tools: toolsWithPropertyNames(), maxRetries: 0 },
    )
    await result.consumeStream()

    // Regression: `propertyNames` compatibility warning and the
    // `reasoningEffort is not supported for non-reasoning models` warning
    // were both logged for every deepseek gateway call.
    expect(emittedWarningsSince(before)).toEqual([])
    expect(bodies).toHaveLength(1)
    expect(JSON.stringify(bodies[0])).not.toContain('propertyNames')
    expect(JSON.stringify(bodies[0])).not.toContain('reasoning')
    expect(bodies[0]).toMatchObject({ model: 'deepseek-v4-flash' })
  })

  it('keeps reasoning controls on the wire for reasoning-capable models', async () => {
    const { baseUrl, bodies } = await startStubServer()
    const selection = deepSeekResponsesSelection(baseUrl, { reasoning: true })
    const before = warnings.length

    const result = await executePipeline(
      requestWith({ reasoningEffort: 'high' }),
      selection,
      { kind: 'stream', maxRetries: 0 },
    )
    await result.consumeStream()

    expect(emittedWarningsSince(before)).toEqual([])
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ model: 'deepseek-v4-flash', reasoning: { effort: 'high' } })
  })
})

describe('buildProtocolProviderOptions reasoning gating', () => {
  const selection = (reasoning?: boolean): ResolvedModelSelection => ({
    ...deepSeekResponsesSelection('https://gateway.example.test/v1'),
    modelDef: { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash', ...(reasoning ? { reasoning: true } : {}) },
  })

  it('drops reasoningEffort and reasoningSummary for non-reasoning models', () => {
    expect(buildProtocolProviderOptions(selection(false), { reasoningEffort: 'high' })).toBeUndefined()
    expect(buildProtocolProviderOptions(selection(false), {
      responseOptions: { reasoningSummary: 'auto', store: false },
    })).toBeUndefined()
  })

  it('keeps reasoning options for reasoning models and forceReasoning overrides', () => {
    expect(buildProtocolProviderOptions(selection(true), { reasoningEffort: 'max' })).toEqual({
      'custom-api:deepseek': { reasoningEffort: 'max' },
    })
    expect(buildProtocolProviderOptions(selection(false), {
      reasoningEffort: 'low',
      responseOptions: { forceReasoning: true },
    })).toEqual({ 'custom-api:deepseek': { reasoningEffort: 'low' } })
  })

  it('keeps thinking options off non-reasoning deepseek responses selections', () => {
    expect(buildThinkingStreamOptions(selection(false), { reasoningEffort: 'high', temperature: 0.3 })).toEqual({
      temperature: 0.3,
    })
    expect(buildThinkingStreamOptions(selection(true), { reasoningEffort: 'high' })).toEqual({
      providerOptions: { 'custom-api:deepseek': { reasoningEffort: 'high' } },
      temperature: undefined,
    })
  })
})
