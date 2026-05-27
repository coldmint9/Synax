import { useEffect } from 'react'
import { subscribe } from '../lib/api/taskNotificationBus'
import { useWikiStore } from '../react/state/wikiStore'

interface RefreshEventPayload {
  taskId: string
  taskKind: string
  message: string
  meta?: Record<string, unknown>
}

export function useWikiRefreshListener(projectId: string | null) {
  useEffect(() => {
    if (!projectId) return

    const handleEvent = (type: string) => (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as RefreshEventPayload
        if (data.taskKind !== 'wiki_refresh') return
        useWikiStore.getState().handleRefreshEvent(type, data)
      } catch { /* ignore parse errors */ }
    }

    return subscribe(projectId, {
      events: {
        task_started: handleEvent('task_started'),
        task_progress: handleEvent('task_progress'),
        task_completed: handleEvent('task_completed'),
        task_failed: handleEvent('task_failed'),
      },
    })
  }, [projectId])
}
