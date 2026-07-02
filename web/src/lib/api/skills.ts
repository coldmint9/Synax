import { apiRequest } from './origin'
import type { AgentProfileKind } from './agentRuntime'

const SKILLS_BASE = '/api/skills'
const SOURCES_BASE = '/api/skill-sources'

export type SkillSourceKind = 'builtin' | 'local' | 'project' | 'remote'
export type SkillSourceType = 'builtin' | 'local' | 'project' | 'well-known' | 'git-index' | 'skills-sh'
export type SkillStatus = 'available' | 'disabled' | 'invalid' | 'update_available'

export interface SkillSummary {
  id: string
  name: string
  label: string
  description: string
  sourceId: string
  sourceKind: SkillSourceKind
  version: string
  appliesTo: AgentProfileKind[]
  requiredCapabilities: string[]
  permissionHints: string[]
  status: SkillStatus
  installPath?: string
  installed?: boolean
  updateAvailable?: boolean
  remoteUrl?: string
  tags?: string[]
}

export interface SkillSourceRecord {
  id: string
  label: string
  type: SkillSourceType
  enabled: boolean
  priority: number
  readOnly: boolean
  config: {
    url?: string
    repo?: string
    ref?: string
    indexPath?: string
    scanPaths?: string[]
  }
  lastSyncAt: string | null
  lastSyncError: string | null
  createdAt: string
  updatedAt: string
}

export interface SkillListResponse {
  items: SkillSummary[]
  total: number
  hasMore: boolean
  totalExact?: boolean
}

export const MARKET_PAGE_SIZE = 24

export const skillsApi = {
  list: (query: {
    profileId?: string
    projectId?: string
    q?: string
    sourceId?: string
    installedOnly?: boolean
    limit?: number
    offset?: number
  } = {}) => {
    const qs = new URLSearchParams()
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        qs.set(key, String(value))
      }
    })
    return apiRequest<SkillListResponse>(`${SKILLS_BASE}${qs.size ? `?${qs.toString()}` : ''}`)
  },
  get: (skillId: string, projectId?: string) => {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
    return apiRequest<SkillSummary & { contentPreview?: string }>(`${SKILLS_BASE}/${encodeURIComponent(skillId)}${qs}`)
  },
  install: (input: { sourceId: string; name: string; version?: string; remoteUrl?: string }) =>
    apiRequest<{ skill: SkillSummary }>(`${SKILLS_BASE}/install`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  uninstall: (skillId: string) =>
    apiRequest<{ ok: boolean }>(`${SKILLS_BASE}/${encodeURIComponent(skillId)}`, { method: 'DELETE' }),
  sync: (sourceId?: string) =>
    apiRequest<{ synced: number; errors?: Array<{ sourceId: string; message: string }> }>(`${SKILLS_BASE}/sync`, {
      method: 'POST',
      body: JSON.stringify(sourceId ? { sourceId } : {}),
    }),
}

export const skillSourcesApi = {
  list: () => apiRequest<{ items: SkillSourceRecord[] }>(SOURCES_BASE),
  create: (input: {
    id: string
    label: string
    type: 'well-known' | 'git-index'
    enabled?: boolean
    priority?: number
    config?: SkillSourceRecord['config']
  }) =>
    apiRequest<{ source: SkillSourceRecord }>(SOURCES_BASE, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  update: (sourceId: string, patch: Partial<Pick<SkillSourceRecord, 'label' | 'enabled' | 'priority' | 'config'>>) =>
    apiRequest<{ source: SkillSourceRecord }>(`${SOURCES_BASE}/${encodeURIComponent(sourceId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  remove: (sourceId: string) =>
    apiRequest<{ ok: boolean }>(`${SOURCES_BASE}/${encodeURIComponent(sourceId)}`, { method: 'DELETE' }),
  sync: (sourceId: string) =>
    apiRequest<{ synced: number }>(`${SOURCES_BASE}/${encodeURIComponent(sourceId)}/sync`, { method: 'POST' }),
  test: (sourceId: string) =>
    apiRequest<{ ok: boolean; error?: string }>(`${SOURCES_BASE}/${encodeURIComponent(sourceId)}/test`, { method: 'POST' }),
}
