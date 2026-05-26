import { CheckCircle2, AlertCircle, Info, AlertTriangle, Bell } from 'lucide-react'
import { useNotificationStore, type Notification, type NotificationType } from '../../state/notificationStore'

const ICONS: Record<NotificationType, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
  warning: AlertTriangle,
}

const ICON_STYLES: Record<NotificationType, string> = {
  info: 'text-primary',
  success: 'text-emerald-500',
  error: 'text-destructive',
  warning: 'text-amber-500',
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分钟前`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}小时前`
  return `${Math.floor(diff / 86400_000)}天前`
}

export function NotificationPanel() {
  const notifications = useNotificationStore(s => s.notifications)
  const unreadCount = useNotificationStore(s => s.unreadCount)
  const markAllRead = useNotificationStore(s => s.markAllRead)
  const clearAll = useNotificationStore(s => s.clearAll)

  return (
    <div className="w-80 max-h-[420px] flex flex-col">
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border/30">
        <span className="text-xs font-medium text-foreground/80">通知</span>
        <div className="flex items-center gap-2">
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={markAllRead}
              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              全部已读
            </button>
          )}
          {notifications.length > 0 && (
            <button
              type="button"
              onClick={clearAll}
              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              清空
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        {notifications.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-muted-foreground/50">
            <Bell size={20} className="mb-2" />
            <span className="text-[11px]">暂无通知</span>
          </div>
        ) : (
          notifications.map(n => (
            <NotificationItem key={n.id} notification={n} />
          ))
        )}
      </div>
    </div>
  )
}

function NotificationItem({ notification }: { notification: Notification }) {
  const markRead = useNotificationStore(s => s.markRead)
  const Icon = ICONS[notification.type]

  return (
    <div
      className={`flex items-start gap-2 px-3.5 py-2.5 border-b border-border/20 last:border-0 cursor-pointer hover:bg-muted/30 transition-colors ${!notification.read ? 'bg-primary/[0.03]' : ''}`}
      onClick={() => markRead(notification.id)}
    >
      <Icon size={13} className={`shrink-0 mt-0.5 ${ICON_STYLES[notification.type]}`} />
      <div className="flex-1 min-w-0">
        <p className="text-[11px] text-foreground/80 leading-relaxed line-clamp-2">{notification.message}</p>
        <span className="text-[10px] text-muted-foreground/50 mt-0.5 block">{relativeTime(notification.timestamp)}</span>
        {notification.action && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); notification.action!.onClick() }}
            className="mt-1 text-[10px] font-medium text-primary hover:text-primary/80 transition-colors"
          >
            {notification.action.label} →
          </button>
        )}
      </div>
      {!notification.read && (
        <span className="shrink-0 mt-1.5 h-1.5 w-1.5 rounded-full bg-primary" />
      )}
    </div>
  )
}
