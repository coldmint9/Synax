import { Hono } from 'hono';
import * as z from 'zod/v4';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { logger } from '../lib/logger.js';
import { DATA_ROOT } from '../lib/env.js';
import { contextService } from '../services/context/context-service.js';
import { getRawSqlite } from '../db/index.js';

// ---------------------------------------------------------------------------
// Project store — in-memory Map 与磁盘 JSON 双写（原子写入）
// 落盘路径：<DATA_ROOT>/projects.json（默认 .data/projects.json）
// 策略：进程启动时从磁盘加载；无文件则用 seeds 初始化并落盘。
// 所有修改操作（POST / PATCH / DELETE）同步写回磁盘。
// ---------------------------------------------------------------------------

export interface ProjectRecord {
  id: string;
  name: string;
  status: 'healthy' | 'at_risk' | 'blocked';
  environment: 'production' | 'staging' | 'development';
  healthScore: number;
  activeAgents: number;
  activeHumans: number;
  openRisks: number;
  updatedAt: string;
  source?: {
    kind: 'scratch' | 'git' | 'localPath';
    repoUrl?: string;
    branch?: string;
    localPath?: string;
  };
  importState?: 'idle' | 'syncing' | 'ready' | 'failed';
  importError?: string;
  createdBy: string;
  createdAt: string;
}

const projects = new Map<string, ProjectRecord>();

const PROJECTS_FILE = resolve(join(DATA_ROOT, 'projects.json'));

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function atomicWriteJson(filePath: string, data: unknown): void {
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmp, filePath);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), file: filePath }, '[store] atomicWrite failed');
    throw err;
  }
}

function loadJsonFile<T>(filePath: string, key?: string): T | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed) return null;
    const data = key ? (parsed[key] as T) : (parsed as T);
    if (!Array.isArray(data)) return null;
    return data as T;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), file: filePath }, '[store] loadJson failed');
    return null;
  }
}

function saveProjectsToDisk(): void {
  const items = Array.from(projects.values());
  atomicWriteJson(PROJECTS_FILE, { items });
}

// ---------------------------------------------------------------------------
// Seed data + disk initialization
// ---------------------------------------------------------------------------

const seedProjects: ProjectRecord[] = [
  {
    id: 'rumbling-core',
    name: 'Rumbling Core',
    status: 'at_risk',
    environment: 'staging',
    healthScore: 72,
    activeAgents: 4,
    activeHumans: 2,
    openRisks: 2,
    updatedAt: 'just now',
    createdBy: 'alice',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'growth-ops',
    name: 'Growth Ops',
    status: 'healthy',
    environment: 'production',
    healthScore: 89,
    activeAgents: 3,
    activeHumans: 1,
    openRisks: 0,
    updatedAt: '12m ago',
    createdBy: 'alice',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'mobile-revamp',
    name: 'Mobile Revamp',
    status: 'blocked',
    environment: 'development',
    healthScore: 54,
    activeAgents: 2,
    activeHumans: 2,
    openRisks: 3,
    updatedAt: '8m ago',
    createdBy: 'alice',
    createdAt: new Date().toISOString(),
  },
];

// Init projects
const diskProjects = loadJsonFile<ProjectRecord[]>(PROJECTS_FILE, 'items');
if (diskProjects !== null) {
  for (const p of diskProjects) projects.set(p.id, p);
  logger.info({ count: projects.size, file: PROJECTS_FILE }, '[projects] loaded from disk');
} else {
  for (const s of seedProjects) projects.set(s.id, s);
  saveProjectsToDisk();
  logger.info({ count: projects.size, file: PROJECTS_FILE }, '[projects] initialized from seeds');
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const createProjectSchema = z.object({
  name: z.string().min(1).max(120),
  environment: z.enum(['production', 'staging', 'development']).default('development'),
  source: z.object({
    kind: z.enum(['scratch', 'git', 'localPath']),
    repoUrl: z.string().optional(),
    branch: z.string().optional(),
    commitSha: z.string().optional(),
    localPath: z.string().optional(),
    provider: z.enum(['github', 'gitlab']).optional(),
  }),
  description: z.string().optional(),
  overwriteExisting: z.boolean().optional(),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  environment: z.enum(['production', 'staging', 'development']).optional(),
  status: z.enum(['healthy', 'at_risk', 'blocked']).optional(),
  healthScore: z.number().int().min(0).max(100).optional(),
  importState: z.enum(['idle', 'syncing', 'ready', 'failed']).optional(),
  importError: z.string().optional(),
  activeAgents: z.number().int().min(0).optional(),
  activeHumans: z.number().int().min(0).optional(),
  openRisks: z.number().int().min(0).optional(),
});

// ---------------------------------------------------------------------------
// Helper: check for duplicate projects
// ---------------------------------------------------------------------------

interface DuplicateCheck {
  exists: boolean;
  existingId?: string;
  existingName?: string;
  reason?: string;
}

function checkDuplicate(source: { kind: string; repoUrl?: string; localPath?: string }): DuplicateCheck {
  for (const p of projects.values()) {
    if (source.kind === 'git' && source.repoUrl && p.source?.repoUrl) {
      const existing = p.source.repoUrl.toLowerCase().replace(/\.git$/, '');
      const incoming = source.repoUrl.toLowerCase().replace(/\.git$/, '');
      if (existing === incoming) {
        return { exists: true, existingId: p.id, existingName: p.name, reason: `已存在相同 Git 仓库的项目「${p.name}」` };
      }
    }
    if (source.kind === 'localPath' && source.localPath && p.source?.localPath) {
      const existing = p.source.localPath.toLowerCase().replace(/\\/g, '/');
      const incoming = source.localPath.toLowerCase().replace(/\\/g, '/');
      if (existing === incoming) {
        return { exists: true, existingId: p.id, existingName: p.name, reason: `已存在相同本地路径的项目「${p.name}」` };
      }
    }
  }
  return { exists: false };
}

// ---------------------------------------------------------------------------
// Helper: cleanup git work directory
// ---------------------------------------------------------------------------

function cleanupGitWorkDir(projectId: string): { cleaned: boolean; error?: string } {
  try {
    const reposDir = resolve(join(DATA_ROOT, 'repos', projectId));
    if (existsSync(reposDir)) {
      rmSync(reposDir, { recursive: true, force: true });
      logger.info({ projectId, path: reposDir }, '[projects] cleaned git work dir');
      return { cleaned: true };
    }
    return { cleaned: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ projectId, err: msg }, '[projects] failed to clean git work dir');
    return { cleaned: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const projectRoutes = new Hono();

// ─── Project Routes ────────────────────────────────────────────────────────

/** GET / — list all projects with optional search, filter, sort */
projectRoutes.get('/', (c) => {
  let items = Array.from(projects.values());

  // Search
  const search = c.req.query('search')?.toLowerCase();
  if (search) {
    items = items.filter(
      p =>
        p.name.toLowerCase().includes(search) ||
        p.id.toLowerCase().includes(search) ||
        (p.source?.repoUrl && p.source.repoUrl.toLowerCase().includes(search)) ||
        (p.source?.localPath && p.source.localPath.toLowerCase().includes(search)),
    );
  }

  // Filter by status
  const statusFilter = c.req.query('status');
  if (statusFilter) {
    const statuses = statusFilter.split(',');
    items = items.filter(p => statuses.includes(p.status));
  }

  // Filter by environment
  const envFilter = c.req.query('environment');
  if (envFilter) {
    const envs = envFilter.split(',');
    items = items.filter(p => envs.includes(p.environment));
  }

  // Filter by import state
  const importFilter = c.req.query('importState');
  if (importFilter) {
    const states = importFilter.split(',');
    items = items.filter(p => p.importState && states.includes(p.importState));
  }

  // Sort
  const sortBy = c.req.query('sort') || 'createdAt';
  const sortDir = c.req.query('order') || 'desc';

  items.sort((a, b) => {
    let aVal: number | string, bVal: number | string;
    switch (sortBy) {
      case 'name':
        aVal = a.name.toLowerCase();
        bVal = b.name.toLowerCase();
        break;
      case 'healthScore':
        aVal = a.healthScore;
        bVal = b.healthScore;
        break;
      case 'updatedAt':
        aVal = new Date(a.updatedAt === 'just now' ? Date.now() : a.updatedAt).getTime();
        bVal = new Date(b.updatedAt === 'just now' ? Date.now() : b.updatedAt).getTime();
        break;
      case 'status':
        aVal = a.status;
        bVal = b.status;
        break;
      case 'environment':
        aVal = a.environment;
        bVal = b.environment;
        break;
      case 'createdAt':
      default:
        aVal = new Date(a.createdAt).getTime();
        bVal = new Date(b.createdAt).getTime();
        break;
    }
    const cmp = typeof aVal === 'string' ? aVal.localeCompare(bVal as string) : aVal - (bVal as number);
    return sortDir === 'asc' ? cmp : -cmp;
  });

  return c.json({ items, total: items.length });
});

// ── Remaining Project Routes ──

/** GET /:id/stats — real-time project statistics from SQLite */
projectRoutes.get('/:id/stats', (c) => {
  const id = c.req.param('id');
  if (!projects.has(id)) return c.json({ error: 'Not found' }, 404);

  const db = getRawSqlite();

  const { total: sessionCount } = contextService.listSessions(id, { limit: 1 });

  const coordState = contextService.getCoordinatesState(id);
  const nodeCount = coordState ? Object.keys(coordState.forest.nodes ?? {}).length : 0;

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recentRuns = db.prepare(
    `SELECT COUNT(*) as c FROM agent_loop_records WHERE project_id = ? AND started_at > ?`,
  ).get(id, sevenDaysAgo) as { c: number } | undefined;

  const lastEvent = db.prepare(
    `SELECT created_at FROM coord_event_log WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).get(id) as { created_at: string } | undefined;

  return c.json({
    sessionCount,
    nodeCount,
    recentRunCount: recentRuns?.c ?? 0,
    lastActivity: lastEvent?.created_at ?? null,
  });
});

/** GET /:id — get single project */
projectRoutes.get('/:id', (c) => {
  const id = c.req.param('id');
  const project = projects.get(id);
  if (!project) return c.json({ error: 'Project not found' }, 404);
  return c.json(project);
});

/** POST /check-duplicate — check if a project with same source already exists */
projectRoutes.post('/check-duplicate', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const { kind, repoUrl, localPath } = body as Record<string, unknown>;
  const result = checkDuplicate({
    kind: (kind as string) ?? '',
    repoUrl: repoUrl as string | undefined,
    localPath: localPath as string | undefined,
  });
  return c.json(result);
});

/** POST / — create project (with duplicate detection) */
projectRoutes.post('/', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = createProjectSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { name, environment, source, description, overwriteExisting } = parsed.data;

  // Check duplicates for git and localPath sources
  if (source.kind !== 'scratch' && !overwriteExisting) {
    const dup = checkDuplicate({
      kind: source.kind,
      repoUrl: source.repoUrl,
      localPath: source.localPath,
    });
    if (dup.exists) {
      return c.json(
        {
          error: 'Duplicate project source detected',
          duplicate: { existingId: dup.existingId, existingName: dup.existingName, reason: dup.reason },
          code: 'DUPLICATE_SOURCE',
        },
        409,
      );
    }
  }

  // If overwriting, delete the existing project first
  if (overwriteExisting && source.kind !== 'scratch') {
    const dup = checkDuplicate({
      kind: source.kind,
      repoUrl: source.repoUrl,
      localPath: source.localPath,
    });
    if (dup.exists && dup.existingId) {
      cleanupGitWorkDir(dup.existingId);
      projects.delete(dup.existingId);
    }
  }

  const id = `proj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const project: ProjectRecord = {
    id,
    name,
    status: 'healthy',
    environment,
    healthScore: source.kind === 'scratch' ? 80 : 0,
    activeAgents: 0,
    activeHumans: 1,
    openRisks: 0,
    updatedAt: 'just now',
    source: {
      kind: source.kind,
      repoUrl: source.repoUrl,
      branch: source.branch || (source.kind === 'git' ? 'main' : undefined),
      localPath: source.localPath,
    },
    importState: source.kind === 'scratch' ? 'ready' : 'syncing',
    createdBy: 'current-user',
    createdAt: new Date().toISOString(),
  };

  projects.set(id, project);
  saveProjectsToDisk();
  logger.info({ projectId: id, name, kind: source.kind }, '[projects] created');

  return c.json({ project }, 201);
});

/** PATCH /:id — update project fields */
projectRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const project = projects.get(id);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = updateProjectSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const oldStatus = project.status;
  const data = parsed.data;

  if (data.name !== undefined) project.name = data.name;
  if (data.environment !== undefined) project.environment = data.environment;
  if (data.status !== undefined) project.status = data.status;
  if (data.healthScore !== undefined) project.healthScore = data.healthScore;
  if (data.importState !== undefined) project.importState = data.importState;
  if (data.importError !== undefined) project.importError = data.importError;
  if (data.activeAgents !== undefined) project.activeAgents = data.activeAgents;
  if (data.activeHumans !== undefined) project.activeHumans = data.activeHumans;
  if (data.openRisks !== undefined) project.openRisks = data.openRisks;

  project.updatedAt = 'just now';
  projects.set(id, project);
  saveProjectsToDisk();

  // Log status changes
  if (data.status && data.status !== oldStatus) {
    logger.info({ projectId: id, from: oldStatus, to: data.status }, '[projects] status changed');
  }

  return c.json(project);
});

/** DELETE /:id — remove project with git work dir cleanup and backup */
projectRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const project = projects.get(id);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  // Create backup before deletion
  const backupFile = resolve(join(DATA_ROOT, `projects_backup_${id}.json`));
  try {
    atomicWriteJson(backupFile, { project, backedUpAt: new Date().toISOString() });
    logger.info({ projectId: id, backup: backupFile }, '[projects] backup created before delete');
  } catch {
    // Non-critical: continue with deletion even if backup fails
    logger.warn({ projectId: id }, '[projects] backup failed, proceeding with delete');
  }

  // Cleanup git work directory
  const cleanupResult = cleanupGitWorkDir(id);

  // Remove from memory and disk
  projects.delete(id);
  saveProjectsToDisk();
  logger.info({ projectId: id, gitCleaned: cleanupResult.cleaned }, '[projects] deleted');

  return c.json({
    ok: true,
    gitCleaned: cleanupResult.cleaned,
    gitCleanError: cleanupResult.error,
    backupFile: existsSync(backupFile) ? backupFile : undefined,
  });
});
