import { apiFetch } from './origin'
import { createAppError, handleError } from '../errors'

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
  status: 'pending' | 'executing' | 'review' | 'accepted' | 'committed'
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
  status: 'draft' | 'confirmed' | 'executing' | 'reviewing' | 'committing' | 'completed' | 'discarded'
  createdAt: string
  updatedAt: string
  confirmedAt: string | null
}

export type PlanNodeSummary = { total: number; completed: number; titles: string[] }
export type WikiPlanWithSummary = WikiPlan & { nodeSummary: PlanNodeSummary }

export type WikiPlanStatus = WikiPlan['status']
export type WikiPlanNodeStatus = WikiPlanNode['status']

export type PlanNodeDraft = {
  title: string
  description: string
  evaluationIds: string[]
  dependsOn: string[]
  expectedFiles: string[]
}

export type PlanStreamEvent =
  | { type: 'started'; sessionId: string }
  | { type: 'phase'; phase: 'analyzing' | 'reading_source' | 'planning' | 'submitting' }
  | { type: 'tool_call'; tool: string; summary: string }
  | { type: 'thought_delta'; delta: string }
  | { type: 'message_delta'; delta: string }
  | { type: 'plan_submitted'; nodes: PlanNodeDraft[] }
  | { type: 'completed'; planId: string; nodeCount: number }
  | { type: 'failed'; error: string }

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

  async listPlans(projectId: string): Promise<WikiPlanWithSummary[]> {
    const res = await apiFetch(`${BASE}/projects/${projectId}/plans`)
    if (!res.ok) throw new Error(`plans/list failed: ${res.status}`)
    const data = await res.json() as { plans: WikiPlanWithSummary[] }
    return data.plans
  },

  async getPlanNodes(planId: string): Promise<WikiPlanNode[]> {
    const res = await apiFetch(`${BASE}/plans/${planId}`)
    if (!res.ok) throw new Error(`plans/detail failed: ${res.status}`)
    const data = await res.json() as { plan: WikiPlan; nodes: WikiPlanNode[] }
    return data.nodes
  },

  async discardPlan(planId: string): Promise<void> {
    const res = await apiFetch(`${BASE}/plans/${planId}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`plans/discard failed: ${res.status}`)
  },

  async updateNode(planId: string, nodeId: string, updates: Partial<Pick<WikiPlanNode, 'title' | 'description' | 'expectedFiles'>>): Promise<void> {
    const res = await apiFetch(`${BASE}/plans/${planId}/nodes/${nodeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    if (!res.ok) throw new Error(`plan-nodes/update failed: ${res.status}`)
  },

  async deleteNode(planId: string, nodeId: string): Promise<void> {
    const res = await apiFetch(`${BASE}/plans/${planId}/nodes/${nodeId}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`plan-nodes/delete failed: ${res.status}`)
  },

  async reorderNodes(planId: string, nodeIds: string[]): Promise<void> {
    const res = await apiFetch(`${BASE}/plans/${planId}/nodes/reorder`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeIds }),
    })
    if (!res.ok) throw new Error(`plans/reorder failed: ${res.status}`)
  },

  streamGeneratePlan(
    projectId: string,
    snapshotId: string,
    workDir: string,
    onEvent: (event: PlanStreamEvent) => void,
    onError?: (err: unknown) => void,
  ): () => void {
    const FRAME_SEP = new RegExp('\\r\\n\\r\\n|\\n\\n|\\r\\r')
    const LINE_SEP = new RegExp('\\r\\n|\\r|\\n')
    const controller = new AbortController()
    ;(async () => {
      try {
        const resp = await apiFetch(`${BASE}/projects/${projectId}/plans/generate/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({ snapshotId, workDir }),
          signal: controller.signal,
        })
        if (!resp.ok || !resp.body) {
          const body = await resp.json().catch(() => ({})) as { error?: string; code?: string }
          const msg = body.error || `generate/stream failed: ${resp.status}`
          const appErr = createAppError(msg, resp.status, body.code)
          handleError(appErr)
          throw appErr
        }
        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let sep: RegExpExecArray | null
          while ((sep = FRAME_SEP.exec(buf))) {
            const frame = buf.slice(0, sep.index)
            buf = buf.slice(sep.index + sep[0].length)
            const dataLines = frame.split(LINE_SEP).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, ''))
            if (dataLines.length === 0) continue
            const payload = dataLines.join('\n').trim()
            if (payload === '[DONE]') return
            try { onEvent(JSON.parse(payload)) } catch { /* ignore parse errors */ }
          }
        }
      } catch (err) {
        if ((err as { name?: string }).name !== 'AbortError') onError?.(err)
      }
    })()
    return () => controller.abort()
  },
}
