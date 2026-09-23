import { resolveProjectWorkDir } from '../services/agent-runtime/tools/workspace.js'
import { Hono } from 'hono'
import { mcpExtensionSchema } from '../services/extensions/schemas.js'
import { mcpClientManager } from '../services/mcp/mcp-client-manager.js'
import type { McpServerConfig } from '../lib/config/config-types.js'

export const mcpRoutes = new Hono()

const mcpServerInputSchema = mcpExtensionSchema

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
    const projectId = c.req.query('projectId')
    if (projectId && config.transport !== 'http' && !config.cwd) config.cwd = resolveProjectWorkDir(projectId)
    const result = await mcpClientManager.probe(config)
    return c.json(result, result.ok ? 200 : 400)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ ok: false, tools: [], error: message }, 400)
  }
})
