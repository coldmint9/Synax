import type { ProjectSummary } from '../../react/state/shellStore'
import { addProject } from '../../react/state/shellStore'
import type {
  CreateProjectFromRepoRequest,
  CreateProjectFromScratchRequest,
} from '../contracts/project'

const API_BASE = '/api/projects'

export interface DuplicateCheckResult {
  exists: boolean
  existingId?: string
  existingName?: string
  reason?: string
}

export interface DeleteResult {
  ok: boolean
  gitCleaned?: boolean
  gitCleanError?: string
  backupFile?: string
}

export interface ProjectStats {
  sessionCount: number
  nodeCount: number
  recentRunCount: number
  lastActivity: string | null
}

export interface ProjectListParams {
  search?: string
  status?: string
  environment?: string
  importState?: string
  sort?: 'name' | 'healthScore' | 'updatedAt' | 'status' | 'environment' | 'createdAt'
  order?: 'asc' | 'desc'
}

export const projectApi = {
  /** List all projects from backend with optional search/filter/sort */
  async listProjects(params?: ProjectListParams): Promise<{ items: ProjectSummary[]; total: number }> {
    try {
      const qs = new URLSearchParams()
      if (params?.search) qs.set('search', params.search)
      if (params?.status) qs.set('status', params.status)
      if (params?.environment) qs.set('environment', params.environment)
      if (params?.importState) qs.set('importState', params.importState)
      if (params?.sort) qs.set('sort', params.sort)
      if (params?.order) qs.set('order', params.order)
      const url = qs.toString() ? `${API_BASE}?${qs.toString()}` : API_BASE
      const resp = await fetch(url)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json()
      const items = (data.items ?? []).map((p: Record<string, unknown>) => mapToProjectSummary(p))
      return { items, total: (data.total as number) ?? items.length }
    } catch {
      return { items: [], total: 0 }
    }
  },

  /** Get a single project by ID */
  async getProject(id: string): Promise<ProjectSummary | null> {
    try {
      const resp = await fetch(`${API_BASE}/${id}`)
      if (!resp.ok) return null
      const p = await resp.json() as Record<string, unknown>
      return mapToProjectSummary(p)
    } catch {
      return null
    }
  },

  /** Check if a project with the same source already exists */
  async checkDuplicate(kind: string, repoUrl?: string, localPath?: string): Promise<DuplicateCheckResult> {
    try {
      const resp = await fetch(`${API_BASE}/check-duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, repoUrl, localPath }),
      })
      if (!resp.ok) return { exists: false }
      return (await resp.json()) as DuplicateCheckResult
    } catch {
      return { exists: false }
    }
  },

  /** Create project via backend */
  async createProject(payload: {
    name: string
    environment: string
    source: { kind: string; repoUrl?: string; branch?: string; commitSha?: string; localPath?: string; provider?: string }
    overwriteExisting?: boolean
  }): Promise<{ project: ProjectSummary }> {
    const resp = await fetch(API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({ error: resp.statusText }))
      if (resp.status === 409 && body.duplicate) {
        const err = new Error(body.duplicate.reason || 'Duplicate project source detected') as Error & { duplicate: Record<string, unknown>; code: string }
        err.duplicate = body.duplicate
        err.code = body.code || 'DUPLICATE_SOURCE'
        throw err
      }
      throw new Error(body.error || `HTTP ${resp.status}`)
    }
    const data = await resp.json()
    const p = data.project
    const project = mapToProjectSummary(p)
    addProject(project)
    return { project }
  },

  /** Update project fields */
  async updateProject(id: string, payload: {
    name?: string
    environment?: string
    status?: string
    healthScore?: number
    importState?: string
    importError?: string
    activeAgents?: number
    activeHumans?: number
    openRisks?: number
  }): Promise<ProjectSummary> {
    const resp = await fetch(`${API_BASE}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({ error: resp.statusText }))
      throw new Error(body.error || `HTTP ${resp.status}`)
    }
    const p = await resp.json() as Record<string, unknown>
    return mapToProjectSummary(p)
  },

  /** Delete project */
  async deleteProject(id: string): Promise<DeleteResult> {
    const resp = await fetch(`${API_BASE}/${id}`, { method: 'DELETE' })
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({ error: resp.statusText }))
      throw new Error(body.error || `HTTP ${resp.status}`)
    }
    return (await resp.json()) as DeleteResult
  },

  /** Get real-time project stats */
  async getProjectStats(id: string): Promise<ProjectStats | null> {
    try {
      const resp = await fetch(`${API_BASE}/${id}/stats`)
      if (!resp.ok) return null
      return (await resp.json()) as ProjectStats
    } catch {
      return null
    }
  },

  // Legacy helper methods
  async createFromScratch(
    payload: CreateProjectFromScratchRequest,
    _operator: string,
  ): Promise<{ project: ProjectSummary }> {
    return projectApi.createProject({
      name: payload.name,
      environment: payload.environment,
      source: { kind: 'scratch' },
    })
  },

  async createFromRepo(
    payload: CreateProjectFromRepoRequest,
    _operator: string,
  ): Promise<{ project: ProjectSummary }> {
    return projectApi.createProject({
      name: payload.name,
      environment: payload.environment,
      source: {
        kind: 'git',
        repoUrl: `https://github.com/${payload.repoFullName}.git`,
        branch: payload.branch,
      },
    })
  },
}

// ── Helper: map backend record to frontend ProjectSummary ──

/** 后端 ProjectRecord.source 使用 kind: scratch | git | localPath 与 repoUrl / localPath */
function mapProjectSource(raw: unknown): ProjectSummary['source'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const s = raw as Record<string, unknown>
  const kindRaw = s.kind as string | undefined
  const repo = s.repoUrl as string | undefined
  const branch = s.branch as string | undefined
  const localPath = s.localPath as string | undefined

  if (kindRaw === 'scratch') return { kind: 'scratch' }
  if (kindRaw === 'git') return { kind: 'github', repo, branch, localPath }
  if (kindRaw === 'localPath') return { kind: 'localPath', localPath, repo, branch }
  if (kindRaw === 'gitlab') return { kind: 'gitlab', repo, branch, localPath }
  return undefined
}

function mapToProjectSummary(p: Record<string, unknown>): ProjectSummary {
  return {
    id: p.id as string,
    name: p.name as string,
    status: (p.status as string) as ProjectSummary['status'] ?? 'healthy',
    environment: (p.environment as string) as ProjectSummary['environment'] ?? 'development',
    healthScore: (p.healthScore as number) ?? 0,
    activeAgents: (p.activeAgents as number) ?? 0,
    activeHumans: (p.activeHumans as number) ?? 1,
    openRisks: (p.openRisks as number) ?? 0,
    updatedAt: (p.updatedAt as string) ?? 'just now',
    source: mapProjectSource(p.source),
    importState: (p.importState as string) as ProjectSummary['importState'],
    importError: (p.importError as string),
    createdBy: (p.createdBy as string) ?? 'current-user',
    createdAt: (p.createdAt as string) ?? new Date().toISOString(),
  }
}
