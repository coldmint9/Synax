import { useState, useRef } from 'react'
import { X, CheckCircle2, AlertCircle, Info, AlertTriangle } from 'lucide-react'
import { useNotificationStore, type Notification, type NotificationType } from '../state/notificationStore'

const ICONS: Record<NotificationType, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
  warning: AlertTriangle,
}

const TYPE_STYLES: Record<NotificationType, string> = {
  info: 'border-primary/30 bg-primary/[0.06]',
  success: 'border-emerald-500/30 bg-emerald-500/[0.06]',
  error: 'border-destructive/30 bg-destructive/[0.06]',
  warning: 'border-amber-500/30 bg-amber-500/[0.06]',
}

const ICON_STYLES: Record<NotificationType, string> = {
  info: 'text-primary',
  success: 'text-emerald-500',
  error: 'text-destructive',
  warning: 'text-amber-500',
}

const MAX_VISIBLE_STACK = 3

export function ToastContainer() {
  const notifications = useNotificationStore(s => s.notifications)
  const visibleToasts = notifications.filter(n => n.visible)
  const [expanded, setExpanded] = useState(false)

  if (visibleToasts.length === 0) return null

  return (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[100] w-[340px]"
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
    primary: 'text-emerald-600 hover:text-emerald-500',
    danger: 'text-destructive hover:text-destructive/80',
  }

  const hidden = !expanded && index >= MAX_VISIBLE_STACK
  const scale = expanded ? 1 : 1 - index * 0.05
  const translateY = expanded ? -(index * 52) : -(index * 8)
  const opacity = hidden ? 0 : 1

  return (
    <div
      ref={ref}
      style={{
        transform: `scale(${scale}) translateY(${translateY}px)`,
        opacity,
        zIndex: total - index,
        position: index === 0 ? 'relative' : 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        pointerEvents: hidden ? 'none' : 'auto',
        transition: 'transform 0.3s ease, opacity 0.3s ease',
      }}
      className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-3 shadow-lg backdrop-blur-sm ${index === 0 ? 'animate-in slide-in-from-bottom-5 fade-in duration-300' : ''} ${TYPE_STYLES[notification.type]}`}
    >
      <Icon size={15} className={`shrink-0 mt-0.5 ${ICON_STYLES[notification.type]}`} />
      <div className="flex-1 min-w-0">
        <p className="text-[12px] text-foreground/85 leading-relaxed">
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
