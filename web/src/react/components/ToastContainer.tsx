import { useEffect, useRef } from 'react'
import { X, CheckCircle2, AlertCircle, Info, AlertTriangle } from 'lucide-react'
import { useToastStore, type Toast, type ToastType } from '../state/toastStore'

const ICONS: Record<ToastType, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
  warning: AlertTriangle,
}

const TYPE_STYLES: Record<ToastType, string> = {
  info: 'border-primary/30 bg-primary/[0.06]',
  success: 'border-emerald-500/30 bg-emerald-500/[0.06]',
  error: 'border-destructive/30 bg-destructive/[0.06]',
  warning: 'border-amber-500/30 bg-amber-500/[0.06]',
}

const ICON_STYLES: Record<ToastType, string> = {
  info: 'text-primary',
  success: 'text-emerald-500',
  error: 'text-destructive',
  warning: 'text-amber-500',
}

export function ToastContainer() {
  const toasts = useToastStore(s => s.toasts)

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col-reverse gap-2 max-w-sm">
      {toasts.map(toast => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  )
}

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useToastStore(s => s.dismiss)
  const ref = useRef<HTMLDivElement>(null)
  const Icon = ICONS[toast.type]

  return (
    <div
      ref={ref}
      className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-3 shadow-lg backdrop-blur-sm animate-in slide-in-from-right-5 fade-in duration-300 ${TYPE_STYLES[toast.type]}`}
    >
      <Icon size={15} className={`shrink-0 mt-0.5 ${ICON_STYLES[toast.type]}`} />
      <div className="flex-1 min-w-0">
        <p className="text-[12px] text-foreground/85 leading-relaxed">{toast.message}</p>
        {toast.action && (
          <button
            type="button"
            onClick={() => { toast.action!.onClick(); dismiss(toast.id) }}
            className="mt-1.5 text-[11px] font-medium text-primary hover:text-primary/80 transition-colors"
          >
            {toast.action.label} →
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => dismiss(toast.id)}
        className="shrink-0 rounded-md p-0.5 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
      >
        <X size={12} />
      </button>
    </div>
  )
}
