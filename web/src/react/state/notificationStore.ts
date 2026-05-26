import { create } from 'zustand'

export type NotificationType = 'info' | 'success' | 'error' | 'warning'

export interface NotificationAction {
  label: string
  onClick: () => void
  variant?: 'default' | 'primary' | 'danger'
}

export interface Notification {
  id: string
  type: NotificationType
  message: string
  action?: NotificationAction
  actions?: NotificationAction[]
  timestamp: number
  read: boolean
  /** toast 是否仍在屏幕上展示 */
  visible: boolean
  duration?: number
}

export interface PushOptions {
  id?: string
  type: NotificationType
  message: string
  action?: NotificationAction
  actions?: NotificationAction[]
  /** 自动消失时间(ms)，0 表示不自动消失，默认 5000 */
  duration?: number
  /** 是否静默（不弹 toast，仅记录到通知中心） */
  silent?: boolean
}

const MAX_NOTIFICATIONS = 100

interface NotificationState {
  notifications: Notification[]
  unreadCount: number

  push: (opts: PushOptions) => string
  dismiss: (id: string) => void
  markRead: (id: string) => void
  markAllRead: () => void
  remove: (id: string) => void
  clearAll: () => void
}

function computeUnread(list: Notification[]): number {
  return list.filter(n => !n.read).length
}

export const useNotificationStore = create<NotificationState>((set) => ({
  notifications: [],
  unreadCount: 0,

  push: (opts) => {
    const id = opts.id ?? crypto.randomUUID().slice(0, 8)
    const existing = useNotificationStore.getState().notifications.find(n => n.id === id)
    if (existing) return id

    const entry: Notification = {
      id,
      type: opts.type,
      message: opts.message,
      action: opts.action,
      actions: opts.actions,
      duration: opts.duration,
      timestamp: Date.now(),
      read: false,
      visible: !opts.silent,
    }

    set(s => {
      const next = [entry, ...s.notifications].slice(0, MAX_NOTIFICATIONS)
      return { notifications: next, unreadCount: computeUnread(next) }
    })

    const duration = opts.duration ?? 5000
    if (duration > 0 && !opts.silent) {
      setTimeout(() => {
        set(s => ({
          notifications: s.notifications.map(n =>
            n.id === id ? { ...n, visible: false } : n,
          ),
        }))
      }, duration)
    }

    return id
  },

  dismiss: (id) => set(s => ({
    notifications: s.notifications.map(n =>
      n.id === id ? { ...n, visible: false } : n,
    ),
  })),

  markRead: (id) => set(s => {
    const notifications = s.notifications.map(n =>
      n.id === id ? { ...n, read: true } : n,
    )
    return { notifications, unreadCount: computeUnread(notifications) }
  }),

  markAllRead: () => set(s => ({
    notifications: s.notifications.map(n => ({ ...n, read: true })),
    unreadCount: 0,
  })),

  remove: (id) => set(s => {
    const notifications = s.notifications.filter(n => n.id !== id)
    return { notifications, unreadCount: computeUnread(notifications) }
  }),

  clearAll: () => set({ notifications: [], unreadCount: 0 }),
}))
