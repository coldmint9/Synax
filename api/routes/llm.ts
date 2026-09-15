import { contentPartsSchema } from '../services/agent-runtime/content-parts.js'
import { modelContentParts, validateAssets } from '../services/agent-runtime/media-assets.js'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import * as z from 'zod/v4'
import { logger } from '../lib/logger.js'
import { createGatewayStream, validateGatewayModel } from '../services/llm-runtime/gateway.js'
import { assertLlmProviderConfigured } from '../services/llm-runtime/provider-check.js'
import { AgentProviderNotConfiguredError } from '../services/agent-runtime/runtime-errors.js'

export const llmRoutes = new Hono()

const llmMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().default(''),
  contentParts: contentPartsSchema.optional(),
})

const llmStreamSchema = z.object({
  projectId: z.string().optional(),
  purpose: z.string().min(1),
  model: z.string().optional(),
  messages: z.array(llmMessageSchema).min(1),
  temperature: z.number().optional(),
  maxTokens: z.number().int().positive().optional(),
  stop: z.array(z.string()).optional(),
  responseOptions: z.object({
    conversation: z.string().optional(),
    include: z.array(z.string()).optional(),
    instructions: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    maxToolCalls: z.number().int().positive().optional(),
    parallelToolCalls: z.boolean().optional(),
    previousResponseId: z.string().optional(),
    promptCacheKey: z.string().optional(),
    promptCacheRetention: z.enum(['in_memory', '24h']).optional(),
    reasoningSummary: z.string().optional(),
    forceReasoning: z.boolean().optional(),
    serviceTier: z.enum(['auto', 'flex', 'priority', 'default']).optional(),
    store: z.boolean().optional(),
    truncation: z.enum(['auto', 'disabled']).optional(),
  }).optional(),
})

const llmValidateSchema = z.object({
  providerId: z.string().optional(),
  model: z.string().min(1),
  apiFormat: z.enum(['openai', 'openai-responses', 'anthropic']).optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
})

llmRoutes.post('/validate', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400)
  }

  const parsed = llmValidateSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ ok: false, error: 'Validation failed', details: parsed.error.flatten() }, 400)
  }

  try {
    const result = await validateGatewayModel(parsed.data)
    return c.json(result, result.ok ? 200 : 400)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ ok: false, error: message }, 400)
  }
})

llmRoutes.post('/stream', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const parsed = llmStreamSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400)
  }

  const input = { ...parsed.data, messages: parsed.data.messages.map(message => ({ role: message.role, content: message.content })) } as import('../services/llm-runtime/types.js').LlmGatewayRequest
  try {
    input.messages = parsed.data.messages.map(message => {
      if (!message.contentParts) return { role: message.role, content: message.content }
      if (message.role !== 'user' || !input.projectId) throw new Error('Media requires a user message and projectId.')
      validateAssets(message.contentParts, input.projectId)
      return { role: 'user' as const, content: modelContentParts(message.contentParts) }
    })
  } catch (error) { return c.json({error:error instanceof Error?error.message:String(error)},400) }

  try {
    assertLlmProviderConfigured(input.projectId)
  } catch (err) {
    if (err instanceof AgentProviderNotConfiguredError) {
      logger.warn({ projectId: input.projectId, purpose: input.purpose }, '[llm] LLM provider not configured for stream')
      return c.json({ error: err.message, code: err.code }, 422)
    }
    return c.json({ error: err instanceof Error ? err.message : 'unknown error' }, 500)
  }

  logger.info({ projectId: input.projectId, purpose: input.purpose, model: input.model }, '[llm] stream request')

  return streamSSE(c, async (stream) => {
    stream.onAbort(() => {
      logger.info({ projectId: input.projectId, purpose: input.purpose }, '[llm] client aborted')
    })

    try {
      const result = await createGatewayStream(input, c.req.raw.signal)
      for await (const delta of result.textStream) {
        if (!delta) continue
        await stream.writeSSE({ data: JSON.stringify({ delta }) })
      }
      await stream.writeSSE({ data: '[DONE]' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ err: message, projectId: input.projectId, purpose: input.purpose }, '[llm] stream failed')
      await stream.writeSSE({ data: JSON.stringify({ error: message }) })
      await stream.writeSSE({ data: '[DONE]' })
    }
  })
})
