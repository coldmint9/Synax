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
  /** 技术原文，浮层里以次要色小字展示，避免污染主文案 */
  detail?: string
  action?: NotificationAction
  actions?: NotificationAction[]
  layout?: 'archive'
  timestamp: number
  read: boolean
  /** toast 是否仍在屏幕上展示 */
  visible: boolean
  duration?: number
  /** 聚合计数（同 id 重复错误） */
  aggregateCount?: number
}

export interface PushOptions {
  id?: string
  type: NotificationType
  message: string
  detail?: string
  action?: NotificationAction
  actions?: NotificationAction[]
  layout?: 'archive'
  /** 自动消失时间(ms)，0 表示不自动消失，默认 5000 */
  duration?: number
  /** 是否静默（不弹 toast，仅记录到通知中心） */
  silent?: boolean
  /**
   * 同 id 已存在时是否重新展示。默认 false：一次性提示不重复打扰；
   * 审批/任务这类"再次发生需要再次提醒"的通知传 true。
   */
  resurface?: boolean
}

export interface PushAggregatedOptions extends PushOptions {
  id: string
  /** false 时仅更新已有通知，不创建新通知 */
  bump?: boolean
}

const MAX_NOTIFICATIONS = 100

const aggregateDismissTimers = new Map<string, ReturnType<typeof setTimeout>>()

function formatAggregatedMessage(base: string, count: number): string {
  const stripped = base
    .replace(/\s*\(\d+\s*次.*?\)\s*$/, '')
    .replace(/\s*\(×\d+\)\s*$/, '')
  if (count <= 1) return stripped
  return `${stripped} (×${count})`
}

function scheduleDismiss(id: string, duration: number): void {
  const prev = aggregateDismissTimers.get(id)
  if (prev) clearTimeout(prev)
  if (duration <= 0) {
    aggregateDismissTimers.delete(id)
    return
  }
  aggregateDismissTimers.set(id, setTimeout(() => {
    aggregateDismissTimers.delete(id)
    useNotificationStore.getState().dismiss(id)
  }, duration))
}

interface NotificationState {
  notifications: Notification[]
  unreadCount: number

  push: (opts: PushOptions) => string
  pushAggregated: (opts: PushAggregatedOptions) => string
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
    const duration = opts.duration ?? 5000

    if (existing) {
      if (!opts.resurface) return id
      set(s => {
        const notifications = s.notifications.map(n =>
          n.id === id
            ? {
                ...n,
                type: opts.type,
                message: opts.message,
                detail: opts.detail,
                action: opts.action,
                actions: opts.actions,
                layout: opts.layout,
                duration,
                timestamp: Date.now(),
                read: false,
                visible: !opts.silent,
              }
            : n,
        )
        return { notifications, unreadCount: computeUnread(notifications) }
      })
      if (!opts.silent) scheduleDismiss(id, duration)
      return id
    }

    const entry: Notification = {
      id,
      type: opts.type,
      message: opts.message,
      detail: opts.detail,
      action: opts.action,
      actions: opts.actions,
      layout: opts.layout,
      duration: opts.duration,
      timestamp: Date.now(),
      read: false,
      visible: !opts.silent,
    }

    set(s => {
      const next = [entry, ...s.notifications].slice(0, MAX_NOTIFICATIONS)
      return { notifications: next, unreadCount: computeUnread(next) }
    })

    if (!opts.silent) scheduleDismiss(id, duration)

    return id
  },

  pushAggregated: (opts) => {
    const { bump = true, duration = 5000, ...rest } = opts
    const existing = useNotificationStore.getState().notifications.find(n => n.id === opts.id)

    if (existing) {
      if (!bump) return opts.id
      const count = (existing.aggregateCount ?? 1) + 1
      set(s => ({
        notifications: s.notifications.map(n =>
          n.id === opts.id
            ? {
                ...n,
                type: rest.type,
                message: formatAggregatedMessage(rest.message, count),
                detail: rest.detail,
                aggregateCount: count,
                timestamp: Date.now(),
                read: false,
                visible: !rest.silent,
                duration,
                action: rest.action,
                actions: rest.actions,
              }
            : n,
        ),
        unreadCount: computeUnread(s.notifications.map(n =>
          n.id === opts.id ? { ...n, read: false } : n,
        )),
      }))
      scheduleDismiss(opts.id, duration)
      return opts.id
    }

    const entry: Notification = {
      id: opts.id,
      type: rest.type,
      message: formatAggregatedMessage(rest.message, 1),
      detail: rest.detail,
      action: rest.action,
      actions: rest.actions,
      duration,
      timestamp: Date.now(),
      read: false,
      visible: !rest.silent,
      aggregateCount: 1,
    }

    set(s => {
      const next = [entry, ...s.notifications].slice(0, MAX_NOTIFICATIONS)
      return { notifications: next, unreadCount: computeUnread(next) }
    })
    scheduleDismiss(opts.id, duration)
    return opts.id
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
