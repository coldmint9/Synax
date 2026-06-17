import { useEffect, useRef } from 'react'
import { useNotificationStore, type NotificationType } from '../react/state/notificationStore'
import { subscribe } from '../lib/api/taskNotificationBus'
import { TaskNotificationEventType } from '../lib/api/eventTypes'
import { useAgentSessionStore } from '../react/features/sessions/agentSessionStore'

interface TaskNotificationPayload {
  id: string
  type: string
  taskKind: string
  projectId: string
  taskId: string
  title: string
  message: string
  severity: 'info' | 'success' | 'warning' | 'error'
  meta?: Record<string, unknown>
}

const severityToType: Record<string, NotificationType> = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'error',
}

export function useTaskNotificationListener(projectId: string | null) {
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!projectId) return

    const scheduleSessionRefresh = () => {
      if (refreshTimer.current) return
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null
        void useAgentSessionStore.getState().refreshSessions()
      }, 300)
    }

    const handleEvent = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as TaskNotificationPayload
        useNotificationStore.getState().push({
          id: `task-${data.id}`,
          type: severityToType[data.severity] ?? 'info',
          message: `${data.title}: ${data.message}`,
          duration: data.severity === 'error' ? 0 : 5000,
        })
      } catch { /* ignore parse errors */ }
    }

    const handleWikiProgress = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as TaskNotificationPayload
        if (data.taskKind === 'wiki_generate') {
          scheduleSessionRefresh()
        }
      } catch { /* ignore parse errors */ }
    }

    const unsubscribe = subscribe(projectId, {
      events: {
        [TaskNotificationEventType.TaskStarted]: handleWikiProgress,
        [TaskNotificationEventType.TaskProgress]: handleWikiProgress,
        [TaskNotificationEventType.TaskCompleted]: handleEvent,
        [TaskNotificationEventType.TaskFailed]: handleEvent,
      },
    })

    return () => {
      unsubscribe()
      if (refreshTimer.current) {
        clearTimeout(refreshTimer.current)
        refreshTimer.current = null
      }
    }
  }, [projectId])
}
