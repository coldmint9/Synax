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

export const projectSettingsRoutes = new Hono()

const sectionSchema = z.enum(['basics', 'provider', 'collaboration', 'notifications', 'compliance'])

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
