import { useCallback, useEffect, useRef, useState } from 'react'
import { subscribe } from '../lib/api/taskNotificationBus'
import { TaskNotificationEventType } from '../lib/api/eventTypes'
import type { WikiSnapshotTree } from '../lib/contracts/wiki'

export type WikiGenPhase = 'starting' | 'refreshing' | 'outline_ready' | 'writing' | 'ready' | 'failed'

export type OutlineActivityPhase = 'scan' | 'explore' | 'delegate' | 'synthesize' | 'submit'

export interface OutlineActivity {
  activity: string
  detail?: string
  phase: OutlineActivityPhase
}

interface WikiGenProgress {
  docIndex?: number
  totalDocs?: number
  docTitle?: string
}

interface WikiGenerationState {
  active: boolean
  phase: WikiGenPhase | null
  progress: WikiGenProgress | null
  error: string | null
  snapshotId: string | null
  outlineActivities: OutlineActivity[]
  currentActivity: string | null
}

interface UseWikiGenerationEventsOptions {
  projectId: string | null
  onCompleted?: (snapshotId: string) => void
  onFailed?: (error: string) => void
  timeoutMs?: number
}

export function useWikiGenerationEvents(opts: UseWikiGenerationEventsOptions) {
  const { projectId, onCompleted, onFailed, timeoutMs = 180_000 } = opts
  const [state, setState] = useState<WikiGenerationState>({
    active: false, phase: null, progress: null, error: null, snapshotId: null,
    outlineActivities: [], currentActivity: null,
  })
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const snapshotIdRef = useRef<string | null>(null)
  const callbacksRef = useRef({ onCompleted, onFailed })
  callbacksRef.current = { onCompleted, onFailed }

  const clearTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  const start = useCallback((snapshotId?: string) => {
    snapshotIdRef.current = snapshotId ?? null
    setState({ active: true, phase: 'starting', progress: null, error: null, snapshotId: snapshotId ?? null, outlineActivities: [], currentActivity: null })
    clearTimer()
    timeoutRef.current = setTimeout(() => {
      setState(s => ({ ...s, active: false, phase: 'failed', error: 'Generation timeout' }))
      callbacksRef.current.onFailed?.('Generation timeout')
    }, timeoutMs)
  }, [timeoutMs, clearTimer])

  const reset = useCallback(() => {
    clearTimer()
    snapshotIdRef.current = null
    setState({ active: false, phase: null, progress: null, error: null, snapshotId: null, outlineActivities: [], currentActivity: null })
  }, [clearTimer])

  useEffect(() => {
    if (!projectId || !state.active) return

    return subscribe(projectId, {
      events: {
        [TaskNotificationEventType.TaskStarted]: (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data)
            if (data.taskKind !== 'wiki_generate') return
            const sid = data.meta?.snapshotId as string | undefined
            if (sid) {
              snapshotIdRef.current = sid
              setState(s => ({ ...s, snapshotId: sid, phase: 'refreshing', outlineActivities: [], currentActivity: null }))
            }
          } catch { /* ignore */ }
        },
        [TaskNotificationEventType.TaskProgress]: (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data)
            if (data.taskKind !== 'wiki_generate') return
            const meta = data.meta as Record<string, unknown> | undefined
            const status = meta?.snapshotStatus as WikiGenPhase | undefined
            if (meta?.snapshotId) snapshotIdRef.current = meta.snapshotId as string
            if (status) setState(s => ({ ...s, phase: status, snapshotId: (meta?.snapshotId as string) ?? s.snapshotId }))
            if (meta?.docIndex != null) {
              setState(s => ({ ...s, progress: {
                docIndex: meta.docIndex as number,
                totalDocs: meta.totalDocs as number,
                docTitle: meta.docTitle as string,
              }}))
            }
            // Phase 1 outline activity tracking
            if (meta?.activity && meta?.activityPhase) {
              const entry: OutlineActivity = {
                activity: meta.activity as string,
                detail: meta.detail as string | undefined,
                phase: meta.activityPhase as OutlineActivityPhase,
              }
              setState(s => ({
                ...s,
                currentActivity: entry.activity,
                outlineActivities: [...s.outlineActivities, entry].slice(-50),
              }))
            }
          } catch { /* ignore */ }
        },
        [TaskNotificationEventType.TaskCompleted]: (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data)
            if (data.taskKind !== 'wiki_generate') return
            clearTimer()
            const sid = (data.meta?.snapshotId as string) ?? state.snapshotId ?? ''
            snapshotIdRef.current = sid || snapshotIdRef.current
            setState(s => ({ ...s, active: false, phase: 'ready', snapshotId: sid }))
            callbacksRef.current.onCompleted?.(sid)
          } catch { /* ignore */ }
        },
        [TaskNotificationEventType.TaskFailed]: (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data)
            if (data.taskKind !== 'wiki_generate') return
            clearTimer()
            const msg = data.message ?? 'Generation failed'
            setState(s => ({ ...s, active: false, phase: 'failed', error: msg }))
            callbacksRef.current.onFailed?.(msg)
          } catch { /* ignore */ }
        },
        [TaskNotificationEventType.WikiSnapshot]: (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data) as { projectId: string; tree: WikiSnapshotTree }
            if (data.projectId !== projectId) return
            if (!data.tree.snapshot) return
            const expectedSnapshotId = snapshotIdRef.current
            if (!expectedSnapshotId || data.tree.snapshot.id !== expectedSnapshotId) return
            if (data.tree.snapshot.status === 'ready') {
              clearTimer()
              setState(s => ({ ...s, active: false, phase: 'ready', snapshotId: data.tree.snapshot?.id ?? s.snapshotId }))
              callbacksRef.current.onCompleted?.(data.tree.snapshot.id)
            } else if (data.tree.snapshot.status === 'failed') {
              clearTimer()
              setState(s => ({ ...s, active: false, phase: 'failed', error: 'Generation failed', snapshotId: data.tree.snapshot?.id ?? s.snapshotId }))
              callbacksRef.current.onFailed?.('Generation failed')
            }
          } catch { /* ignore */ }
        },
      },
    })
  }, [projectId, state.active, clearTimer])

  useEffect(() => () => clearTimer(), [clearTimer])

  return { ...state, start, reset }
}
