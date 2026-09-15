import { useMemo, useState, useRef } from 'react'
import { X, CheckCircle2, AlertCircle, Info, AlertTriangle } from 'lucide-react'
import { useNotificationStore, type Notification, type NotificationType } from '../state/notificationStore'

const ICONS: Record<NotificationType, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
  warning: AlertTriangle,
}

/* HeroUI default toast: the surface stays opaque and only the indicator/title
   carries the variant tone, so no per-type translucent background is needed. */
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
      className="fixed top-16 right-4 z-[100] w-[340px] max-sm:right-3 max-sm:top-[4.5rem]"
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
  const ref = useRef<HTMLDivElement>(null)
  const Icon = ICONS[notification.type]

  const VARIANT_STYLES: Record<string, string> = {
    default: 'text-primary hover:text-primary/80',
    primary: 'text-success hover:text-success',
    danger: 'text-destructive hover:text-destructive/80',
  }

  const hidden = !expanded && index >= MAX_VISIBLE_STACK
  const scale = expanded ? 1 : 1 - index * 0.05
  const translateY = expanded ? index * 52 : index * 8
  const opacity = hidden ? 0 : 1

  return (
    <div
      ref={ref}
      style={{
        transform: `scale(${scale}) translateY(${translateY}px)`,
        opacity,
        zIndex: total - index,
        position: index === 0 ? 'relative' : 'absolute',
        top: 0,
        left: 0,
        right: 0,
        pointerEvents: hidden ? 'none' : 'auto',
        transition: 'transform 0.3s ease, opacity 0.3s ease',
      }}
      className={`flex items-start gap-2.5 rounded-3xl bg-surface px-4 py-3 shadow-overlay ${index === 0 ? 'animate-in slide-in-from-right-5 fade-in duration-300' : ''}`}
    >
      <Icon size={15} className={`shrink-0 mt-0.5 ${ICON_STYLES[notification.type]}`} />
      <div className="flex-1 min-w-0">
        <p className="text-sm leading-relaxed text-overlay-foreground">
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
      <button
        type="button"
        onClick={() => dismiss(notification.id)}
        className="shrink-0 rounded-md p-0.5 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
      >
        <X size={12} />
      </button>
    </div>
  )
}
