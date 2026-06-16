import { apiFetch } from './origin'
import { createAppError, handleError } from '../errors'

const BASE = '/api/wiki'

export type GoalAnchor = {
  type: 'heading' | 'selection'
  heading?: string
  quote?: string
}

export type WikiGoal = {
  id: string
  projectId: string
  scope: 'project' | 'document'
  documentId: string | null
  content: string
  anchorJson: GoalAnchor | null
  status: 'active' | 'planned' | 'in_progress' | 'resolved'
  planNodeId: string | null
  lastSessionId: string | null
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
  goalIds: string[]
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
  goalIds: string[]
  status: 'draft' | 'confirmed' | 'executing' | 'reviewing' | 'committing' | 'completed' | 'discarded'
  createdAt: string
  updatedAt: string
  confirmedAt: string | null
}

export type PlanNodeArtifactPatch = {
  filePath: string
  diff: string
  action: 'create' | 'modify' | 'delete'
}

export type WikiPlanNodeArtifact = {
  id: string
  nodeId: string
  planId: string
  sessionId: string | null
  patches: PlanNodeArtifactPatch[]
  executionLog: string | null
  commitMessage: string | null
  status: 'pending' | 'generated' | 'accepted' | 'committed' | 'discarded'
  redoCount: number
  redoFeedback: string | null
  createdAt: string
  updatedAt: string
}

export type PlanNodeSummary = { total: number; completed: number; titles: string[] }
export type WikiPlanWithSummary = WikiPlan & { nodeSummary: PlanNodeSummary }

export type PlanNodeDraft = {
  title: string
  description: string
  goalIds: string[]
  dependsOn: string[]
  expectedFiles: string[]
}

export type PlanStreamEvent =
  | { type: 'started'; sessionId: string }
  | { type: 'phase'; phase: 'analyzing' | 'reading_source' | 'planning' | 'submitting' }
  | { type: 'tool_call'; tool: string; summary: string }
  | { type: 'thought_delta'; delta: string }
  | { type: 'message_delta'; delta: string }
  | { type: 'node_submitted'; node: PlanNodeDraft; index: number }
  | { type: 'completed'; planId: string; nodeCount: number }
  | { type: 'failed'; error: string }

export type PlanExecuteEvent =
  | { type: 'plan_status'; status: string }
  | { type: 'node_status'; nodeId: string; status: string; title: string }
  | { type: 'node_review'; nodeId: string; artifactId: string }
  | { type: 'plan_completed'; planId: string }
  | { type: 'failed'; error: string }

export const goalApi = {
  async list(projectId: string, status?: string): Promise<WikiGoal[]> {
    const qs = status ? `?status=${status}` : ''
    const res = await apiFetch(`${BASE}/projects/${projectId}/goals${qs}`)
    if (!res.ok) throw new Error(`goals/list failed: ${res.status}`)
    const data = await res.json() as { goals: WikiGoal[] }
    return data.goals
  },

  async create(projectId: string, body: {
    content: string
    scope?: 'project' | 'document'
    documentId?: string | null
    anchorJson?: GoalAnchor | null
  }): Promise<WikiGoal> {
    const res = await apiFetch(`${BASE}/projects/${projectId}/goals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`goals/create failed: ${res.status}`)
    return res.json() as Promise<WikiGoal>
  },

  async buildSessionPrompt(projectId: string, body: {
    mode?: 'direct' | 'plan_node'
    content: string
    documentId?: string | null
    documentTitle?: string | null
    anchorJson?: GoalAnchor | null
    locale?: 'zh' | 'en'
  }): Promise<string> {
    const res = await apiFetch(`${BASE}/projects/${projectId}/goals/session-prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`goals/session-prompt failed: ${res.status}`)
    const data = await res.json() as { prompt: string }
    return data.prompt
  },

  async linkLastSession(goalId: string, sessionId: string): Promise<void> {
    const res = await apiFetch(`${BASE}/goals/${goalId}/last-session`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    if (!res.ok) throw new Error(`goals/last-session failed: ${res.status}`)
  },

  async delete(goalId: string): Promise<void> {
    const res = await apiFetch(`${BASE}/goals/${goalId}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`goals/delete failed: ${res.status}`)
  },

  async updateStatus(goalId: string, status: WikiGoal['status']): Promise<void> {
    const res = await apiFetch(`${BASE}/goals/${goalId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    if (!res.ok) throw new Error(`goals/updateStatus failed: ${res.status}`)
  },

  async listByDocument(documentId: string): Promise<WikiGoal[]> {
    const res = await apiFetch(`${BASE}/documents/${documentId}/goals`)
    if (!res.ok) throw new Error(`goals/listByDocument failed: ${res.status}`)
    const data = await res.json() as { goals: WikiGoal[] }
    return data.goals
  },

  async getActivePlan(projectId: string): Promise<{ plan: WikiPlan | null; nodes: WikiPlanNode[] }> {
    const res = await apiFetch(`${BASE}/projects/${projectId}/plans/active`)
    if (!res.ok) throw new Error(`plans/active failed: ${res.status}`)
    return res.json() as Promise<{ plan: WikiPlan | null; nodes: WikiPlanNode[] }>
  },

  async confirmPlan(projectId: string, planId: string, workDir?: string): Promise<void> {
    const res = await apiFetch(`${BASE}/projects/${projectId}/plans/${planId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir }),
    })
    if (!res.ok) throw new Error(`plans/confirm failed: ${res.status}`)
  },

  async generatePlan(projectId: string, snapshotId: string): Promise<{ plan: WikiPlan; nodes: WikiPlanNode[] }> {
    const res = await apiFetch(`${BASE}/projects/${projectId}/plans/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId }),
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

  async getNodeArtifact(planId: string, nodeId: string): Promise<WikiPlanNodeArtifact> {
    const res = await apiFetch(`${BASE}/plans/${planId}/nodes/${nodeId}/artifact`)
    if (!res.ok) throw new Error(`artifact/get failed: ${res.status}`)
    const data = await res.json() as { artifact: WikiPlanNodeArtifact }
    return data.artifact
  },

  async acceptPlanNode(planId: string, nodeId: string, workDir: string): Promise<void> {
    const res = await apiFetch(`${BASE}/plans/${planId}/nodes/${nodeId}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir }),
    })
    if (!res.ok) throw new Error(`nodes/accept failed: ${res.status}`)
  },

  async redoPlanNode(planId: string, nodeId: string, feedback: string): Promise<void> {
    const res = await apiFetch(`${BASE}/plans/${planId}/nodes/${nodeId}/redo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback }),
    })
    if (!res.ok) throw new Error(`nodes/redo failed: ${res.status}`)
  },

  async discardPlan(planId: string): Promise<void> {
    const res = await apiFetch(`${BASE}/plans/${planId}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`plans/discard failed: ${res.status}`)
  },

  async deletePlan(planId: string): Promise<void> {
    const res = await apiFetch(`${BASE}/plans/${planId}?permanent=true`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`plans/delete failed: ${res.status}`)
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
          body: JSON.stringify({ snapshotId }),
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
            try { onEvent(JSON.parse(payload)) } catch { /* ignore */ }
          }
        }
      } catch (err) {
        if ((err as { name?: string }).name !== 'AbortError') onError?.(err)
      }
    })()
    return () => controller.abort()
  },

  streamPlanExecution(
    planId: string,
    onEvent: (event: PlanExecuteEvent) => void,
    onError?: (err: unknown) => void,
  ): () => void {
    const FRAME_SEP = new RegExp('\\r\\n\\r\\n|\\n\\n|\\r\\r')
    const LINE_SEP = new RegExp('\\r\\n|\\r|\\n')
    const controller = new AbortController()
    ;(async () => {
      try {
        const resp = await apiFetch(`${BASE}/plans/${planId}/execute/stream`, {
          method: 'GET',
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal,
        })
        if (!resp.ok || !resp.body) throw new Error(`execute/stream failed: ${resp.status}`)
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
            try { onEvent(JSON.parse(payload)) } catch { /* ignore */ }
          }
        }
      } catch (err) {
        if ((err as { name?: string }).name !== 'AbortError') onError?.(err)
      }
    })()
    return () => controller.abort()
  },
}
