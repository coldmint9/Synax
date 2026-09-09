import { Hono } from 'hono'
import * as z from 'zod/v4'
import { mcpClientManager } from '../services/mcp/mcp-client-manager.js'
import type { McpServerConfig } from '../lib/config/config-types.js'

export const mcpRoutes = new Hono()

const mcpServerInputSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(256),
    command: z.string().min(1).max(1024),
    args: z.array(z.string().min(1).max(1024)).max(64).optional(),
    env: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()

mcpRoutes.post('/test', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400)
  }
  const parsed = mcpServerInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ ok: false, error: 'MCP 配置无效', details: parsed.error.flatten() }, 400)
  }
  const config: McpServerConfig = parsed.data
  try {
    const result = await mcpClientManager.probe(config)
    return c.json(result, result.ok ? 200 : 400)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ ok: false, tools: [], error: message }, 400)
  }
})
