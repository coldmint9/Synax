import { apiFetch } from './origin'

const BASE = '/api/wiki'

export type WikiEvaluation = {
  id: string
  projectId: string
  blockId: string
  content: string
  status: 'active' | 'planned' | 'resolved'
  planNodeId: string | null
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
}

export type WikiPlanNode = {
  id: string
  planId: string
  projectId: string
  title: string
  description: string
  evaluationIds: string[]
  dependsOn: string[]
  expectedFiles: string[]
  status: 'pending' | 'in_progress' | 'completed' | 'incomplete'
  sortOrder: number
  reviewResult: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export type WikiPlan = {
  id: string
  projectId: string
  snapshotId: string
  evaluationIds: string[]
  status: 'draft' | 'confirmed' | 'in_progress' | 'completed'
  createdAt: string
  updatedAt: string
  confirmedAt: string | null
}

export const evaluationApi = {
  async list(projectId: string, status?: string): Promise<WikiEvaluation[]> {
    const qs = status ? `?status=${status}` : ''
    const res = await apiFetch(`${BASE}/projects/${projectId}/evaluations${qs}`)
    if (!res.ok) throw new Error(`evaluations/list failed: ${res.status}`)
    const data = await res.json() as { evaluations: WikiEvaluation[] }
    return data.evaluations
  },

  async create(projectId: string, blockId: string, content: string): Promise<WikiEvaluation> {
    const res = await apiFetch(`${BASE}/projects/${projectId}/evaluations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blockId, content }),
    })
    if (!res.ok) throw new Error(`evaluations/create failed: ${res.status}`)
    return res.json() as Promise<WikiEvaluation>
  },

  async delete(evalId: string): Promise<void> {
    const res = await apiFetch(`${BASE}/evaluations/${evalId}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`evaluations/delete failed: ${res.status}`)
  },

  async updateStatus(evalId: string, status: WikiEvaluation['status']): Promise<void> {
    const res = await apiFetch(`${BASE}/evaluations/${evalId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    if (!res.ok) throw new Error(`evaluations/updateStatus failed: ${res.status}`)
  },

  async listByBlock(blockId: string): Promise<WikiEvaluation[]> {
    const res = await apiFetch(`${BASE}/blocks/${blockId}/evaluations`)
    if (!res.ok) throw new Error(`evaluations/listByBlock failed: ${res.status}`)
    const data = await res.json() as { evaluations: WikiEvaluation[] }
    return data.evaluations
  },

  async getActivePlan(projectId: string): Promise<{ plan: WikiPlan | null; nodes: WikiPlanNode[] }> {
    const res = await apiFetch(`${BASE}/projects/${projectId}/plans/active`)
    if (!res.ok) throw new Error(`plans/active failed: ${res.status}`)
    return res.json() as Promise<{ plan: WikiPlan | null; nodes: WikiPlanNode[] }>
  },

  async confirmPlan(projectId: string, planId: string): Promise<void> {
    const res = await apiFetch(`${BASE}/projects/${projectId}/plans/${planId}/confirm`, { method: 'POST' })
    if (!res.ok) throw new Error(`plans/confirm failed: ${res.status}`)
  },

  async generatePlan(projectId: string, snapshotId: string, workDir: string): Promise<{ plan: WikiPlan; nodes: WikiPlanNode[] }> {
    const res = await apiFetch(`${BASE}/projects/${projectId}/plans/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId, workDir }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      throw new Error(body.error || `plans/generate failed: ${res.status}`)
    }
    return res.json() as Promise<{ plan: WikiPlan; nodes: WikiPlanNode[] }>
  },
}
