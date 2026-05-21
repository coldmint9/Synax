import type { CoordinatesContextIndex, CoordForest, CorrectionReason } from '../coordinates'

export type ReviewRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'discarded' | 'applied'
export type ReviewOverallVerdict = 'accepted' | 'rejected' | 'blocked'
export type ActionReviewVerdict = 'accept' | 'reject' | 'blocked'

export interface ReviewAgentLogEntry {
  turn: number
  tool: string
  thought?: string
  args?: Record<string, unknown>
  resultSummary?: string
}

export interface GoalReviewRun {
  id: string
  projectId: string
  goalId: string
  status: ReviewRunStatus
  startedAt: number
  completedAt?: number
  summary: string
  overallVerdict: ReviewOverallVerdict
}

export interface ActionReviewDecision {
  actionId: string
  verdict: ActionReviewVerdict
  confidence: number
  rationale: string
  evidenceSummary: string
  issues: string[]
  suggestions: string[]
  correctionNote?: string
  correctionReasons?: CorrectionReason[]
  suggestedPrompt?: string
}

export interface GoalReviewPackage {
  run: GoalReviewRun
  decisions: ActionReviewDecision[]
  improvementPlan: string[]
  agentLog: ReviewAgentLogEntry[]
  warnings: string[]
}

export type GoalReviewStreamEvent =
  | { type: 'review_started'; payload: { run: GoalReviewRun } }
  | { type: 'review_turn'; payload: ReviewAgentLogEntry }
  | { type: 'review_tool_result'; payload: { turn: number; tool: string; resultSummary: string } }
  | { type: 'review_action_decision'; payload: ActionReviewDecision }
  | { type: 'review_completed'; payload: { package: GoalReviewPackage } }
  | { type: 'review_failed'; payload: { runId?: string; reason: string } }

export interface StartGoalReviewInput {
  projectId: string
  goalId: string
  forest: CoordForest
  contextIndex?: CoordinatesContextIndex
  workDir?: string | null
  locale?: 'zh' | 'en'
}

const API_BASE = '/api/coordinates'

export function startGoalReviewStream(
  input: StartGoalReviewInput,
  onEvent: (event: GoalReviewStreamEvent) => void,
  onError?: (err: unknown) => void,
): () => void {
  return openSseStream('/review/goal/stream', input, onEvent as (e: unknown) => void, onError)
}

function openSseStream(
  path: string,
  input: unknown,
  onEvent: (event: unknown) => void,
  onError?: (err: unknown) => void,
): () => void {
  const frameSep = new RegExp('\\r\\n\\r\\n|\\n\\n|\\r\\r')
  const lineSep = new RegExp('\\r\\n|\\r|\\n')
  const controller = new AbortController()
  ;(async () => {
    try {
      const resp = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(input),
        signal: controller.signal,
      })
      if (!resp.ok || !resp.body) throw new Error(`${path} ${resp.status}`)
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let sep: RegExpExecArray | null
        while ((sep = frameSep.exec(buf))) {
          const frame = buf.slice(0, sep.index)
          buf = buf.slice(sep.index + sep[0].length)
          const dataLines = frame
            .split(lineSep)
            .filter(l => l.startsWith('data:'))
            .map(l => l.slice(5).replace(/^ /, ''))
          if (dataLines.length === 0) continue
          const payload = dataLines.join('\n').trim()
          if (payload === '[DONE]') return
          onEvent(JSON.parse(payload))
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name !== 'AbortError') onError?.(err)
    }
  })()
  return () => controller.abort()
}
