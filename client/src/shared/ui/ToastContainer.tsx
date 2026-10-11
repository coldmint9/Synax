import { useMemo, useState } from 'react'
import { X, Archive, CheckCircle2, AlertCircle, Info, AlertTriangle } from 'lucide-react'
import { useNotificationStore, type Notification, type NotificationType } from '../state/notificationStore'

const ICONS: Record<NotificationType, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
  warning: AlertTriangle,
}

const ICON_STYLES: Record<NotificationType, string> = {
  info: 'text-accent-soft-foreground',
  success: 'text-success-soft-foreground',
  error: 'text-danger-soft-foreground',
  warning: 'text-warning-soft-foreground',
}

const MAX_VISIBLE_STACK = 3

export function ToastContainer() {
  const notifications = useNotificationStore(s => s.notifications)
  const visibleToasts = useMemo(
    () => notifications.filter(n => n.visible),
    [notifications],
  )
  const [expanded, setExpanded] = useState(false)

  if (visibleToasts.length === 0) return null

  return (
    <div
      className={`fixed left-1/2 top-14 z-[100] max-w-[calc(100vw-24px)] -translate-x-1/2 ${visibleToasts.some(n => n.layout === 'archive') ? 'w-max min-w-[280px]' : 'w-[280px]'}`}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
    >
      <div className="relative">
        {visibleToasts.map((n, i) => (
          <ToastItem
            key={n.id}
            notification={n}
            index={i}
            total={visibleToasts.length}
            expanded={expanded}
          />
        ))}
      </div>
    </div>
  )
}

function ToastItem({ notification, index, total, expanded }: {
  notification: Notification
  index: number
  total: number
  expanded: boolean
}) {
  const dismiss = useNotificationStore(s => s.dismiss)
  const archive = notification.layout === 'archive'
  const Icon = archive ? Archive : ICONS[notification.type]

  const VARIANT_STYLES: Record<string, string> = {
    default: 'text-primary hover:text-primary/80',
    primary: 'text-success hover:text-success',
    danger: 'text-destructive hover:text-destructive/80',
  }

  const hidden = !expanded && index >= MAX_VISIBLE_STACK
  const scale = expanded ? 1 : 1 - index * 0.05
  const translateY = expanded ? index * (archive ? 76 : 44) : index * 7
  const opacity = hidden ? 0 : 1

  return (
    <div
      style={{
        transform: `scale(${scale}) translateY(${translateY}px)`,
        opacity,
        zIndex: total - index,
        position: index === 0 ? 'relative' : 'absolute',
        top: 0,
        left: 0,
        right: 0,
        pointerEvents: hidden ? 'none' : 'auto',
      }}
      className="motion-safe:transition-[transform,opacity] motion-safe:duration-300 motion-safe:ease-out"
    >
      <div role={archive ? 'status' : undefined} className={archive
        ? 'flex items-center gap-3 rounded-2xl border border-black/10 bg-white px-5 py-3 text-zinc-900 shadow-overlay dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-50 motion-safe:animate-toast-enter'
        : 'flex items-start gap-2 rounded-xl border border-black/10 bg-white/90 px-3 py-2 text-zinc-900 shadow-overlay backdrop-blur-xl dark:border-white/15 dark:bg-black/80 dark:text-zinc-50 motion-safe:animate-toast-enter'}>
        <Icon size={archive ? 20 : 14} className={archive ? 'shrink-0' : `mt-0.5 shrink-0 ${ICON_STYLES[notification.type]}`} />
        {archive ? (
          <>
            <p className="min-w-0 flex-1 text-base font-medium leading-6">{notification.message}</p>
            {notification.actions?.map((action, i) => (
              <button
                key={i}
                type="button"
                onClick={() => { action.onClick(); dismiss(notification.id) }}
                className={action.variant === 'primary'
                  ? 'shrink-0 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-white'
                  : 'shrink-0 rounded-xl bg-zinc-100 px-4 py-2 text-sm font-medium transition-colors hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700'}
              >
                {action.label}
              </button>
            ))}
          </>
        ) : (
        <div className="flex-1 min-w-0">
          <p className="text-xs leading-5 text-inherit">
            {notification.message}
          </p>
          {notification.actions && notification.actions.length > 0 && (
            <div className="mt-1.5 flex items-center gap-3">
              {notification.actions.map((a, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => { a.onClick(); dismiss(notification.id) }}
                  className={`text-[11px] font-medium transition-colors ${VARIANT_STYLES[a.variant ?? 'default']}`}
                >
                  {a.label}
                </button>
              ))}
            </div>
          )}
          {!notification.actions && notification.action && (
            <button
              type="button"
              onClick={() => { notification.action!.onClick(); dismiss(notification.id) }}
              className="mt-1.5 text-[11px] font-medium text-primary hover:text-primary/80 transition-colors"
            >
              {notification.action.label} →
            </button>
          )}
        </div>
        )}
        <button
          type="button"
          onClick={() => dismiss(notification.id)}
          aria-label="关闭通知"
          className="shrink-0 rounded-md p-0.5 text-muted-foreground/70 hover:text-foreground transition-colors"
        >
          <X size={archive ? 18 : 12} />
        </button>
      </div>
    </div>
  )
}
