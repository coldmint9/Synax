import { useEffect, useRef } from 'react'
import { useShellStore } from '../react/state/shellStore'
import { useNotificationStore } from '../react/state/notificationStore'
import { subscribe } from '../lib/api/runtimeEventBus'

export function sendDesktopNotification(title: string, body: string) {
  const enabled = useShellStore.getState().preferences.notifications
  if (!enabled) return
  if (typeof Notification === 'undefined') return
  if (Notification.permission !== 'granted') return
  if (document.visibilityState === 'visible') return
  new Notification(title, { body, icon: '/favicon.svg' })
}

export function useDesktopNotification(projectId: string | null) {
  const notifications = useShellStore(s => s.preferences.notifications)
  const prevRef = useRef(notifications)
  const notifiedRef = useRef(new Set<string>())

  useEffect(() => {
    if (notifications && !prevRef.current) {
      if (typeof Notification === 'undefined') {
        useShellStore.getState().setNotifications(false)
        return
      }
      if (Notification.permission === 'denied') {
        useShellStore.getState().setNotifications(false)
        useNotificationStore.getState().push({
          type: 'warning',
          message: 'Browser notifications are blocked. Please enable them in browser settings.',
          duration: 5000,
        })
        return
      }
      if (Notification.permission === 'default') {
        Notification.requestPermission().then(result => {
          if (result !== 'granted') {
            useShellStore.getState().setNotifications(false)
          }
        })
      }
    }
    prevRef.current = notifications
  }, [notifications])

  useEffect(() => {
    if (!projectId || !notifications) return

    return subscribe({
      events: {
        session_changed: (e) => {
          try {
            const data = JSON.parse(e.data) as {
              sessionId: string
              patch?: { status?: string; title?: string; blockedReason?: string }
            }
            const id = data.sessionId
            const status = data.patch?.status

            if (status === 'waiting_permission') {
              if (notifiedRef.current.has(id)) return
              notifiedRef.current.add(id)
              sendDesktopNotification(
                'Agent needs approval',
                data.patch?.blockedReason ?? 'Permission request pending',
              )
            } else if (status === 'completed') {
              notifiedRef.current.delete(id)
              sendDesktopNotification(
                'Agent completed',
                data.patch?.title ?? `Session ${id.slice(0, 8)} finished`,
              )
            } else if (status === 'failed') {
              notifiedRef.current.delete(id)
              sendDesktopNotification(
                'Agent failed',
                data.patch?.title ?? `Session ${id.slice(0, 8)} encountered an error`,
              )
            }
          } catch { /* ignore parse errors */ }
        },
      },
    })
  }, [projectId, notifications])
}