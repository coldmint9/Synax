import { useCallback, useEffect, useRef, useState } from 'react'
import { subscribe } from '../lib/api/taskNotificationBus'
import { TaskNotificationEventType } from '../lib/api/eventTypes'
import type { WikiSnapshotTree } from '../lib/contracts/wiki'
import { wikiGenTimeoutForPhase } from '../lib/constants/wikiGeneration'

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
  doneDocs?: number
  docTitle?: string
  documentId?: string
}

interface WikiGenerationState {
  active: boolean
  stale: boolean
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
  onStale?: (message: string) => void
  onReconnect?: () => void
  onProgress?: () => void
  /** Override default phase-based inactivity timeout. */
  timeoutMs?: number
}

export function useWikiGenerationEvents(opts: UseWikiGenerationEventsOptions) {
  const { projectId, onCompleted, onFailed, onStale, onReconnect, onProgress, timeoutMs } = opts
  const [state, setState] = useState<WikiGenerationState>({
    active: false,
    stale: false,
    phase: null,
    progress: null,
    error: null,
    snapshotId: null,
    outlineActivities: [],
    currentActivity: null,
  })
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const snapshotIdRef = useRef<string | null>(null)
  const phaseRef = useRef<WikiGenPhase | null>(null)
  const callbacksRef = useRef({ onCompleted, onFailed, onStale, onReconnect, onProgress })
  callbacksRef.current = { onCompleted, onFailed, onStale, onReconnect, onProgress }

  const clearTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  const resetTimer = useCallback((phase?: WikiGenPhase | null) => {
    if (phase !== undefined) {
      phaseRef.current = phase
    }
    clearTimer()
    const duration = timeoutMs ?? wikiGenTimeoutForPhase(phaseRef.current)
    timeoutRef.current = setTimeout(() => {
      const message = 'Generation progress tracking timed out'
      setState(s => ({
        ...s,
        active: false,
        stale: true,
        phase: null,
        error: null,
      }))
      callbacksRef.current.onStale?.(message)
      callbacksRef.current.onFailed?.(message)
    }, duration)
  }, [timeoutMs, clearTimer])

  const start = useCallback((snapshotId?: string, initialPhase: WikiGenPhase = 'starting') => {
    snapshotIdRef.current = snapshotId ?? null
    phaseRef.current = initialPhase
    setState({
      active: true,
      stale: false,
      phase: initialPhase,
      progress: null,
      error: null,
      snapshotId: snapshotId ?? null,
      outlineActivities: [],
      currentActivity: null,
    })
    resetTimer(initialPhase)
  }, [resetTimer])

  const reset = useCallback(() => {
    clearTimer()
    snapshotIdRef.current = null
    phaseRef.current = null
    setState({
      active: false,
      stale: false,
      phase: null,
      progress: null,
      error: null,
      snapshotId: null,
      outlineActivities: [],
      currentActivity: null,
    })
  }, [clearTimer])

  useEffect(() => {
    if (!projectId || !state.active) return

    return subscribe(projectId, {
      onConnect: () => {
        resetTimer(phaseRef.current)
        callbacksRef.current.onReconnect?.()
      },
      events: {
        [TaskNotificationEventType.TaskStarted]: (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data)
            if (data.taskKind !== 'wiki_generate') return
            const sid = data.meta?.snapshotId as string | undefined
            if (sid) {
              snapshotIdRef.current = sid
              phaseRef.current = 'refreshing'
              setState(s => ({
                ...s,
                snapshotId: sid,
                phase: 'refreshing',
                outlineActivities: [],
                currentActivity: null,
              }))
              resetTimer('refreshing')
            }
          } catch { /* ignore */ }
        },
        [TaskNotificationEventType.TaskProgress]: (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data)
            if (data.taskKind !== 'wiki_generate') return
            callbacksRef.current.onProgress?.()
            const meta = data.meta as Record<string, unknown> | undefined
            const status = meta?.snapshotStatus as WikiGenPhase | undefined
            if (meta?.snapshotId) snapshotIdRef.current = meta.snapshotId as string
            if (status) {
              phaseRef.current = status
              setState(s => ({ ...s, phase: status, snapshotId: (meta?.snapshotId as string) ?? s.snapshotId }))
              resetTimer(status)
            } else {
              resetTimer()
            }
            if (meta?.docIndex != null || meta?.doneDocs != null || meta?.totalDocs != null) {
              setState(s => ({ ...s, progress: {
                docIndex: meta.docIndex as number | undefined,
                totalDocs: meta.totalDocs as number | undefined,
                doneDocs: meta.doneDocs as number | undefined,
                docTitle: meta.docTitle as string | undefined,
                documentId: meta.documentId as string | undefined,
              }}))
            }
            if (meta?.paused === true || status === 'partial') {
              clearTimer()
              phaseRef.current = null
              setState(s => ({
                ...s,
                active: false,
                phase: null,
                progress: null,
                snapshotId: (meta?.snapshotId as string) ?? s.snapshotId,
              }))
            }
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
            const sid = (data.meta?.snapshotId as string) ?? snapshotIdRef.current ?? ''
            snapshotIdRef.current = sid || snapshotIdRef.current
            phaseRef.current = 'ready'
            setState(s => ({ ...s, active: false, stale: false, phase: 'ready', snapshotId: sid }))
            callbacksRef.current.onCompleted?.(sid)
          } catch { /* ignore */ }
        },
        [TaskNotificationEventType.TaskFailed]: (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data)
            if (data.taskKind !== 'wiki_generate') return
            clearTimer()
            const msg = data.message ?? 'Generation failed'
            phaseRef.current = 'failed'
            setState(s => ({ ...s, active: false, stale: false, phase: 'failed', error: msg }))
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
            const snapStatus = data.tree.snapshot.status
            if (snapStatus === 'ready') {
              clearTimer()
              phaseRef.current = 'ready'
              setState(s => ({ ...s, active: false, stale: false, phase: 'ready', snapshotId: data.tree.snapshot?.id ?? s.snapshotId }))
              callbacksRef.current.onCompleted?.(data.tree.snapshot.id)
            } else if (snapStatus === 'failed') {
              clearTimer()
              phaseRef.current = 'failed'
              setState(s => ({ ...s, active: false, stale: false, phase: 'failed', error: 'Generation failed', snapshotId: data.tree.snapshot?.id ?? s.snapshotId }))
              callbacksRef.current.onFailed?.('Generation failed')
            } else if (snapStatus === 'partial') {
              clearTimer()
              phaseRef.current = null
              setState(s => ({
                ...s,
                active: false,
                stale: false,
                phase: null,
                progress: null,
                snapshotId: data.tree.snapshot?.id ?? s.snapshotId,
              }))
            } else if (snapStatus === 'refreshing' || snapStatus === 'writing' || snapStatus === 'outline_ready') {
              phaseRef.current = snapStatus
              setState(s => ({ ...s, phase: snapStatus, snapshotId: data.tree.snapshot?.id ?? s.snapshotId }))
              resetTimer(snapStatus)
            }
          } catch { /* ignore */ }
        },
      },
    })
  }, [projectId, state.active, clearTimer, resetTimer])

  useEffect(() => () => clearTimer(), [clearTimer])

  return { ...state, start, reset }
}
