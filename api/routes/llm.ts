import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import * as z from 'zod/v4'
import { logger } from '../lib/logger.js'
import { createGatewayStream, validateGatewayModel } from '../services/llm-runtime/stream.js'

export const llmRoutes = new Hono()

const llmMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
})

const llmStreamSchema = z.object({
  projectId: z.string().optional(),
  purpose: z.string().min(1),
  model: z.string().optional(),
  messages: z.array(llmMessageSchema).min(1),
  temperature: z.number().optional(),
  maxTokens: z.number().int().positive().optional(),
  stop: z.array(z.string()).optional(),
})

const llmValidateSchema = z.object({
  providerId: z.string().optional(),
  model: z.string().min(1),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  options: z.record(z.unknown()).optional(),
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

  const input = parsed.data
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
