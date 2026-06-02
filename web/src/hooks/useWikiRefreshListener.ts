import { useEffect } from 'react'
import { subscribe } from '../lib/api/taskNotificationBus'
import { TaskNotificationEventType } from '../lib/api/eventTypes'
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
        [TaskNotificationEventType.TaskStarted]: handleEvent(TaskNotificationEventType.TaskStarted),
        [TaskNotificationEventType.TaskProgress]: handleEvent(TaskNotificationEventType.TaskProgress),
        [TaskNotificationEventType.TaskCompleted]: handleEvent(TaskNotificationEventType.TaskCompleted),
        [TaskNotificationEventType.TaskFailed]: handleEvent(TaskNotificationEventType.TaskFailed),
      },
    })
  }, [projectId])
}
