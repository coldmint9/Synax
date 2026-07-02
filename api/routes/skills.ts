import { Hono } from 'hono';
import * as z from 'zod/v4';
import { skillRegistry } from '../services/skills/skill-registry.js';
import { skillInstallService } from '../services/skills/skill-install-service.js';
import { skillIndexService } from '../services/skills/skill-index-service.js';
import { fetchSkillText } from '../services/skills/skill-http.js';
import { fetchSkillsShSkillContent } from '../services/skills/skills-sh-client.js';
import { skillSourceService } from '../services/skills/skill-source-service.js';

export const skillsRoutes = new Hono();

const listSkillsQuerySchema = z.object({
  profileId: z.string().min(1).max(64).optional(),
  projectId: z.string().min(1).max(128).optional(),
  q: z.string().max(256).optional(),
  sourceId: z.string().min(1).max(128).optional(),
  installedOnly: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const installSchema = z.object({
  sourceId: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  version: z.string().max(64).optional(),
  remoteUrl: z.string().url().optional(),
});

const syncSchema = z.object({
  sourceId: z.string().min(1).max(128).optional(),
});

skillsRoutes.get('/', async (c) => {
  const parsed = listSkillsQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const result = await skillRegistry.listWithTotal({
    profileId: parsed.data.profileId,
    projectId: parsed.data.projectId,
    q: parsed.data.q,
    sourceId: parsed.data.sourceId,
    installedOnly: parsed.data.installedOnly === 'true',
    limit: parsed.data.limit,
    offset: parsed.data.offset,
  });

  return c.json(result);
});

skillsRoutes.post('/install', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = installSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  try {
    const skill = await skillInstallService.install(parsed.data);
    return c.json({ skill }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});

skillsRoutes.post('/sync', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = syncSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  try {
    if (parsed.data.sourceId) {
      const synced = await skillIndexService.syncSource(parsed.data.sourceId);
      return c.json({ synced, errors: [] });
    }
    const result = await skillIndexService.syncAll();
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});

skillsRoutes.post('/:skillId/enable', (c) => {
  const skillId = decodeURIComponent(c.req.param('skillId'));
  try {
    const install = skillInstallService.enable(skillId);
    return c.json({ skill: skillRegistry.getSummary(install.id) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 404);
  }
});

skillsRoutes.post('/:skillId/disable', (c) => {
  const skillId = decodeURIComponent(c.req.param('skillId'));
  try {
    skillInstallService.disable(skillId);
    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 404);
  }
});

skillsRoutes.delete('/:skillId', (c) => {
  const skillId = decodeURIComponent(c.req.param('skillId'));
  try {
    skillInstallService.uninstall(skillId);
    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});

skillsRoutes.get('/:skillId/content', async (c) => {
  const skillId = decodeURIComponent(c.req.param('skillId'));
  const projectId = c.req.query('projectId') ?? undefined;
  try {
    const detail = skillRegistry.loadDetail({ skillId, projectId });
    return c.json({ content: detail.content });
  } catch {
    try {
      const summary = skillRegistry.getSummary(skillId, projectId);
      if (!summary.remoteUrl) {
        return c.json({ error: 'Skill not found' }, 404);
      }
      const content = await fetchSkillText(summary.remoteUrl);
      return c.json({ content });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 404);
    }
  }
});

skillsRoutes.get('/:skillId', async (c) => {
  const skillId = decodeURIComponent(c.req.param('skillId'));
  const projectId = c.req.query('projectId') ?? undefined;
  try {
    const summary = skillRegistry.getSummary(skillId, projectId);
    let contentPreview = '';
    try {
      const detail = skillRegistry.loadDetail({ skillId, projectId });
      contentPreview = detail.content.slice(0, 2048);
    } catch {
      if (summary.remoteUrl?.includes('skills.sh/api/v1/skills/')
        || summary.remoteUrl?.includes('skills.sh/api/download')) {
        const content = await fetchSkillsShSkillContent(summary.remoteUrl);
        contentPreview = content.slice(0, 2048);
      }
    }
    return c.json({
      ...summary,
      contentPreview,
    });
  } catch {
    return c.json({ error: 'Skill not found' }, 404);
  }
});

export const skillSourcesRoutes = new Hono();

const createSourceSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[a-z0-9-]+$/),
  label: z.string().min(1).max(128),
  type: z.enum(['well-known', 'git-index']),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  readOnly: z.boolean().optional(),
  config: z.object({
    url: z.string().url().optional(),
    repo: z.string().min(1).max(256).optional(),
    ref: z.string().min(1).max(128).optional(),
    indexPath: z.string().min(1).max(256).optional(),
  }).default({}),
});

const patchSourceSchema = z.object({
  label: z.string().min(1).max(128).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  readOnly: z.boolean().optional(),
  config: z.object({
    url: z.string().url().optional(),
    repo: z.string().min(1).max(256).optional(),
    ref: z.string().min(1).max(128).optional(),
    indexPath: z.string().min(1).max(256).optional(),
  }).optional(),
});

skillSourcesRoutes.get('/', (c) => {
  return c.json({ items: skillSourceService.listSources() });
});

skillSourcesRoutes.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createSourceSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  try {
    const source = skillSourceService.createSource(parsed.data);
    return c.json({ source }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});

skillSourcesRoutes.patch('/:sourceId', async (c) => {
  const sourceId = decodeURIComponent(c.req.param('sourceId'));
  const body = await c.req.json().catch(() => null);
  const parsed = patchSourceSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  try {
    const source = skillSourceService.updateSource(sourceId, parsed.data);
    return c.json({ source });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});

skillSourcesRoutes.delete('/:sourceId', (c) => {
  const sourceId = decodeURIComponent(c.req.param('sourceId'));
  try {
    skillSourceService.deleteSource(sourceId);
    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});

skillSourcesRoutes.post('/:sourceId/test', async (c) => {
  const sourceId = decodeURIComponent(c.req.param('sourceId'));
  try {
    await skillIndexService.syncSource(sourceId);
    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: message }, 400);
  }
});

skillSourcesRoutes.post('/:sourceId/sync', async (c) => {
  const sourceId = decodeURIComponent(c.req.param('sourceId'));
  try {
    const synced = await skillIndexService.syncSource(sourceId);
    return c.json({ synced });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});
