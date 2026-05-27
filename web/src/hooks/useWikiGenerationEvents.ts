import { useCallback, useEffect, useRef, useState } from 'react'
import { subscribe } from '../lib/api/taskNotificationBus'
import { wikiApi } from '../lib/api/wiki'

export type WikiGenPhase = 'starting' | 'refreshing' | 'outline_ready' | 'writing' | 'ready' | 'failed'

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
  })
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const callbacksRef = useRef({ onCompleted, onFailed })
  callbacksRef.current = { onCompleted, onFailed }

  const clearTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  const start = useCallback((snapshotId?: string) => {
    setState({ active: true, phase: 'starting', progress: null, error: null, snapshotId: snapshotId ?? null })
    clearTimer()
    timeoutRef.current = setTimeout(async () => {
      if (!projectId) return
      try {
        const tree = await wikiApi.getLatest(projectId)
        if (tree.snapshot?.status === 'ready') {
          setState(s => ({ ...s, active: false, phase: 'ready' }))
          callbacksRef.current.onCompleted?.(tree.snapshot.id)
        } else if (tree.snapshot?.status === 'failed') {
          setState(s => ({ ...s, active: false, phase: 'failed', error: 'Generation timeout' }))
          callbacksRef.current.onFailed?.('Generation timeout')
        } else {
          setState(s => ({ ...s, active: false, phase: 'failed', error: 'Generation timeout' }))
          callbacksRef.current.onFailed?.('Generation timeout')
        }
      } catch {
        setState(s => ({ ...s, active: false, phase: 'failed', error: 'Generation timeout' }))
        callbacksRef.current.onFailed?.('Generation timeout')
      }
    }, timeoutMs)
  }, [projectId, timeoutMs, clearTimer])

  const reset = useCallback(() => {
    clearTimer()
    setState({ active: false, phase: null, progress: null, error: null, snapshotId: null })
  }, [clearTimer])

  useEffect(() => {
    if (!projectId || !state.active) return

    return subscribe(projectId, {
      events: {
        task_progress: (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data)
            if (data.taskKind !== 'wiki_generate') return
            const meta = data.meta as Record<string, unknown> | undefined
            const status = meta?.snapshotStatus as WikiGenPhase | undefined
            if (status) setState(s => ({ ...s, phase: status, snapshotId: (meta?.snapshotId as string) ?? s.snapshotId }))
            if (meta?.docIndex != null) {
              setState(s => ({ ...s, progress: {
                docIndex: meta.docIndex as number,
                totalDocs: meta.totalDocs as number,
                docTitle: meta.docTitle as string,
              }}))
            }
          } catch { /* ignore */ }
        },
        task_completed: (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data)
            if (data.taskKind !== 'wiki_generate') return
            clearTimer()
            const sid = (data.meta?.snapshotId as string) ?? state.snapshotId ?? ''
            setState(s => ({ ...s, active: false, phase: 'ready', snapshotId: sid }))
            callbacksRef.current.onCompleted?.(sid)
          } catch { /* ignore */ }
        },
        task_failed: (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data)
            if (data.taskKind !== 'wiki_generate') return
            clearTimer()
            const msg = data.message ?? 'Generation failed'
            setState(s => ({ ...s, active: false, phase: 'failed', error: msg }))
            callbacksRef.current.onFailed?.(msg)
          } catch { /* ignore */ }
        },
      },
    })
  }, [projectId, state.active, clearTimer])

  useEffect(() => () => clearTimer(), [clearTimer])

  return { ...state, start, reset }
}
