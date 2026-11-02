import { vi as nativeTestConfig } from "vitest";
nativeTestConfig.setConfig({ testTimeout: 15_000 });
import { ensureTestRuntime } from "../../../../test-fixtures/rust-runtime.js";
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { generateText, nativeModel } from '../../../../test-fixtures/native-generation.js'
import { beforeAll, afterEach, describe, expect, it } from 'vitest'
import type { ResolvedProviderConfig } from '../types.js'
import type { ModelMessage, ProviderOptions } from '../contracts.js'
import { streamRustAgentLoop } from '../../../modules/agent-runtime/rust-agent-loop-client.js'

type CapturedRequest = {
  url: string
  body: Record<string, unknown>
}

beforeAll(async () => { await ensureTestRuntime(); });

const servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve())
  })))
})

async function startStubServer(payload: unknown, maxStoredInputItems?: number): Promise<{ baseUrl: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      requests.push({
        url: req.url ?? '',
        body,
      })
      if (maxStoredInputItems !== undefined && body.store !== false
        && Array.isArray(body.input) && body.input.length > maxStoredInputItems) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `Maximum of ${maxStoredInputItems} items allowed in input.` } }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const value = payload as any
      if (req.url?.endsWith('/responses')) {
        res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: value.output[0].content[0].text })}\n\n`)
        res.end(`data: ${JSON.stringify({ type: 'response.completed', response: value })}\n\n`)
      } else {
        res.write(`data: ${JSON.stringify({ ...value, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: value.choices[0].message.content }, finish_reason: null }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ ...value, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
        res.end('data: [DONE]\n\n')
      }
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests }
}

function responsesPayload(text: string) {
  return {
    id: 'resp_test',
    object: 'response',
    created_at: 1_700_000_000,
    status: 'completed',
    model: 'gpt-5.4-codex',
    output: [
      {
        type: 'message',
        id: 'msg_test',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    parallel_tool_calls: false,
    tool_choice: 'auto',
    tools: [],
    incomplete_details: null,
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
  }
}

describe('OpenAI Responses protocol wire format', () => {
  it('posts to /responses when the connection protocol is openai-responses', async () => {
    const { baseUrl, requests } = await startStubServer(responsesPayload('pong'))
    const config: ResolvedProviderConfig = {
      providerId: 'custom-api:codex-gateway',
      apiFormat: 'openai-responses',
      baseUrl,
      apiKey: 'sk-test',
    }

    const model = nativeModel({ ...config, apiFormat: "openai-responses", model: "gpt-5.4-codex", prompt: [] })
    const result = await generateText({
      model: model as Parameters<typeof generateText>[0]['model'],
      messages: [{ role: 'user', content: 'ping' }],
      maxRetries: 0,
    })

    expect(result.text).toBe('pong')
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/v1/responses')
    expect(requests[0].body).toMatchObject({ model: 'gpt-5.4-codex', input: expect.anything(), store: false })
    expect(requests[0].body).not.toHaveProperty('messages')
  })

  it.each(['provider', 'agent-loop'] as const)('%s replays over 1000 input items without losing reasoning and tool exchanges', async entry => {
    const { baseUrl, requests } = await startStubServer(responsesPayload('continued'), 1000)
    const messages: ModelMessage[] = [{ role: 'user', content: 'Keep the complete history.' }]
    const turns = 251
    for (let index = 0; index < turns; index++) {
      messages.push(
        { role: 'assistant', content: [
          { type: 'reasoning', text: `Thought ${index}`, providerOptions: { openai: {
            itemId: `rs_${index}`, reasoningEncryptedContent: `encrypted_${index}`,
          } } },
          { type: 'tool-call', toolCallId: `call_${index}`, toolName: 'inspect', input: { index } },
        ] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: `call_${index}`, toolName: 'inspect',
          output: { type: 'text', value: `Evidence ${index}` } }] },
        { role: 'user', content: `<system-reminder>Step ${index} complete.</system-reminder>` },
      )
    }
    const config = { apiFormat: 'openai-responses', providerId: 'custom-api:gateway',
      model: 'deepseek-flash', baseUrl, apiKey: 'fixture', prompt: [] }
    const providerOptions = { 'custom-api:gateway': { include: ['file_search_call.results'] } }
    if (entry === 'provider') {
      const result = await generateText({ model: nativeModel(config), messages, maxRetries: 0, providerOptions })
      expect(result.text).toBe('continued')
    } else {
      const events = []
      for await (const event of streamRustAgentLoop({ ...config, prompt: messages, providerOptions })) events.push(event)
      expect(events.filter(event => event.type === 'error')).toEqual([])
      expect(events.filter(event => event.type === 'text-delta').map(event => event.delta).join('')).toBe('continued')
      expect(events.at(-1)?.type).toBe('done')
    }

    expect(requests).toHaveLength(1)
    const body = requests[0].body
    expect(body).toMatchObject({ store: false, include: ['file_search_call.results', 'reasoning.encrypted_content'] })
    const items = body.input as Array<Record<string, unknown>>
    expect(items).toHaveLength(1 + turns * 4)
    const calls = items.filter(item => item.type === 'function_call')
    const results = items.filter(item => item.type === 'function_call_output')
    expect(calls.map(item => item.call_id)).toEqual(Array.from({ length: turns }, (_, index) => `call_${index}`))
    expect(results.map(item => [item.call_id, item.output])).toEqual(
      Array.from({ length: turns }, (_, index) => [`call_${index}`, `Evidence ${index}`]),
    )
    expect(items.filter(item => item.type === 'reasoning').map(item => item.encrypted_content))
      .toEqual(Array.from({ length: turns }, (_, index) => `encrypted_${index}`))
  })

  it.each<ProviderOptions>([
    { openai: { store: true } },
    { 'custom-api:gateway': { store: true } },
    { 'custom-api:gateway': { extraBody: { store: true } } },
    { openai: { previousResponseId: 'resp_previous' } },
    { 'custom-api:gateway': { extraBody: { conversation: 'conv_previous' } } },
    { openai: { background: true } },
  ])('preserves explicitly configured upstream storage and stateful requests: %j', async providerOptions => {
    const { baseUrl, requests } = await startStubServer(responsesPayload('pong'))
    await generateText({
      model: nativeModel({ apiFormat: 'openai-responses', providerId: 'custom-api:gateway',
        model: 'fixture', baseUrl, apiKey: 'fixture', prompt: [] }),
      messages: [{ role: 'user', content: 'continue' }], providerOptions, maxRetries: 0,
    })
    expect(requests[0].body.store).not.toBe(false)
  })

  it('passes stored reasoning_text back to DeepSeek Responses', async () => {
    const { baseUrl, requests } = await startStubServer(responsesPayload('continued'))
    const config: ResolvedProviderConfig = {
      providerId: 'openai',
      apiFormat: 'openai-responses',
      baseUrl,
      apiKey: 'sk-test',
    }

    const model = nativeModel({ ...config, apiFormat: "openai-responses", model: "deepseek-v4-flash", prompt: [] })
    await generateText({
      model: model as Parameters<typeof generateText>[0]['model'],
      messages: [
        { role: 'user', content: 'first' },
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'stored thinking',
              providerOptions: {
                openai: {
                  itemId: 'reasoning_1',
                  reasoningContent: [{ type: 'reasoning_text', text: 'stored thinking' }],
                },
              },
            },
            { type: 'text', text: 'first answer' },
          ],
        },
        { role: 'user', content: 'continue' },
      ] as never,
      maxRetries: 0,
    })

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/v1/responses')
    expect(requests[0].body).toMatchObject({
      input: expect.arrayContaining([
        expect.objectContaining({
          type: 'reasoning',
          content: [{ type: 'reasoning_text', text: 'stored thinking' }],
        }),
      ]),
    })
  })

  it('posts to /chat/completions when the connection protocol is openai', async () => {
    const { baseUrl, requests } = await startStubServer({
      id: 'chatcmpl_test',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    })
    const config: ResolvedProviderConfig = {
      providerId: 'custom-api:gateway',
      apiFormat: 'openai',
      baseUrl,
      apiKey: 'sk-test',
    }

    const model = nativeModel({ ...config, apiFormat: "openai", model: "gpt-4o-mini", prompt: [] })
    const result = await generateText({
      model: model as Parameters<typeof generateText>[0]['model'],
      messages: [{ role: 'user', content: 'ping' }],
      maxRetries: 0,
    })

    expect(result.text).toBe('pong')
    expect(requests.map(request => request.url)).toEqual(['/v1/chat/completions'])
    expect(requests[0].body).toMatchObject({ model: 'gpt-4o-mini' })
    expect(requests[0].body).toHaveProperty('messages')
    expect(requests[0].body).not.toHaveProperty('store')
    expect(requests[0].body).not.toHaveProperty('include')
  })

  it('keeps openai-compatible clients on chat completions for the openai protocol', async () => {
    const { baseUrl, requests } = await startStubServer({
      id: 'chatcmpl_test',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'deepseek-v4-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    })
    const config: ResolvedProviderConfig = {
      providerId: 'custom-api:deepseek',
      apiFormat: 'openai',
      baseUrl,
      apiKey: 'sk-test',
    }

    const model = nativeModel({ ...config, apiFormat: "openai", model: "deepseek-v4-flash", prompt: [] })
    const result = await generateText({
      model: model as Parameters<typeof generateText>[0]['model'],
      messages: [{ role: 'user', content: 'ping' }],
      maxRetries: 0,
    })

    expect(result.text).toBe('pong')
    expect(requests.map(request => request.url)).toEqual(['/v1/chat/completions'])
  })
})
