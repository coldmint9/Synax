import { Hono } from 'hono'
import * as z from 'zod/v4'
import {
  getProjectSettings,
  updateProjectSettings,
  patchProjectSettingsSection,
  deleteProjectSettings,
  archiveProject,
  restoreProject,
  transferProject,
} from '../lib/config/project-settings-store.js'
import { getEffectiveConfigForDisplay } from '../lib/config/config-store.js'
import { syncProjectBasics } from './projects.js'
import { logger } from '../lib/logger.js'
import { readWorkspaceProject } from '../services/project-workspace.js'
import { discoverLocalIntegrations, importDiscoveredSkill } from '../services/integrations/local-discovery.js'
import { discoverLocalMcpServers } from '../services/mcp/mcp-discovery.js'

export const projectSettingsRoutes = new Hono()

const sectionSchema = z.enum(['basics', 'provider', 'mcp', 'collaboration', 'notifications', 'compliance'])

const highRiskAuthSchema = z.object({
  confirmPhrase: z.string().min(1),
  securityCode: z.string().min(1),
  justification: z.string().min(8),
})

projectSettingsRoutes.get('/:projectId/settings', (c) => {
  const projectId = c.req.param('projectId')
  try {
    const settings = getProjectSettings(projectId)
    return c.json({ settings })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ projectId, err: msg }, '[project-settings] get failed')
    return c.json({ error: msg }, 500)
  }
})

projectSettingsRoutes.get('/:projectId/settings/effective', (c) => {
  const projectId = c.req.param('projectId')
  try {
    const settings = getProjectSettings(projectId)
    const effective = getEffectiveConfigForDisplay(projectId)
    return c.json({ settings, effective })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ projectId, err: msg }, '[project-settings] get effective failed')
    return c.json({ error: msg }, 500)
  }
})

projectSettingsRoutes.get('/:projectId/settings/mcp/discovery', (c) => {
  const projectId = c.req.param('projectId')
  try {
    const project = readWorkspaceProject(projectId)
    return c.json(discoverLocalMcpServers(project?.source?.localPath))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ projectId, err: msg }, '[project-settings] MCP discovery failed')
    return c.json({ error: msg }, 500)
  }
})

const discoveryInput = z.object({ directories: z.array(z.string().min(1).max(4096)).max(8).default([]) })

projectSettingsRoutes.post('/:projectId/settings/integrations/discovery', async (c) => {
  const parsed = discoveryInput.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'Invalid discovery directories' }, 400)
  const project = readWorkspaceProject(c.req.param('projectId'))
  if (!project?.source?.localPath) return c.json({ error: 'A local project directory is required' }, 404)
  const { paths: _paths, ...result } = discoverLocalIntegrations(project.source.localPath, { extraDirectories: parsed.data.directories })
  return c.json(result)
})

projectSettingsRoutes.post('/:projectId/settings/integrations/skills/import', async (c) => {
  const parsed = discoveryInput.extend({ id: z.string().regex(/^[a-f0-9]{24}$/) }).safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid skill import' }, 400)
  const project = readWorkspaceProject(c.req.param('projectId'))
  if (!project?.source?.localPath) return c.json({ error: 'A local project directory is required' }, 404)
  try {
    return c.json(importDiscoveredSkill(project.source.localPath, parsed.data.id, { extraDirectories: parsed.data.directories }), 201)
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409) }
})

projectSettingsRoutes.put('/:projectId/settings', async (c) => {
  const projectId = c.req.param('projectId')
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  try {
    const settings = updateProjectSettings(projectId, body as any, 'current-user')
    syncProjectBasics(projectId, settings.basics)
    return c.json({ settings })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ projectId, err: msg }, '[project-settings] update failed')
    return c.json({ error: msg }, 500)
  }
})

projectSettingsRoutes.patch('/:projectId/settings/:section', async (c) => {
  const projectId = c.req.param('projectId')
  const section = c.req.param('section')
  const parsed = sectionSchema.safeParse(section)
  if (!parsed.success) {
    return c.json({ error: `Invalid section: ${section}` }, 400)
  }
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  try {
    const settings = patchProjectSettingsSection(projectId, parsed.data, body, 'current-user')
    if (parsed.data === 'basics') {
      syncProjectBasics(projectId, settings.basics)
    }
    return c.json({ settings })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ projectId, section, err: msg }, '[project-settings] patch section failed')
    return c.json({ error: msg }, 500)
  }
})

projectSettingsRoutes.delete('/:projectId/settings', (c) => {
  const projectId = c.req.param('projectId')
  const deleted = deleteProjectSettings(projectId)
  return c.json({ ok: true, deleted })
})

projectSettingsRoutes.post('/:projectId/settings/archive', async (c) => {
  const projectId = c.req.param('projectId')
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  const authParsed = z.object({ auth: highRiskAuthSchema }).safeParse(body)
  if (!authParsed.success) {
    return c.json({ error: 'Invalid auth envelope', details: authParsed.error.flatten() }, 400)
  }
  try {
    const settings = archiveProject(projectId, authParsed.data.auth, 'current-user')
    return c.json({ settings })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: msg }, 500)
  }
})

projectSettingsRoutes.post('/:projectId/settings/restore', async (c) => {
  const projectId = c.req.param('projectId')
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  const authParsed = z.object({ auth: highRiskAuthSchema }).safeParse(body)
  if (!authParsed.success) {
    return c.json({ error: 'Invalid auth envelope', details: authParsed.error.flatten() }, 400)
  }
  try {
    const settings = restoreProject(projectId, authParsed.data.auth, 'current-user')
    return c.json({ settings })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: msg }, 500)
  }
})

projectSettingsRoutes.post('/:projectId/settings/transfer', async (c) => {
  const projectId = c.req.param('projectId')
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  const transferSchema = z.object({
    newOwnerMemberId: z.string().min(1),
    auth: highRiskAuthSchema,
  })
  const parsed = transferSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400)
  }
  try {
    const settings = transferProject(projectId, parsed.data.newOwnerMemberId, parsed.data.auth, 'current-user')
    return c.json({ settings })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: msg }, 500)
  }
})
