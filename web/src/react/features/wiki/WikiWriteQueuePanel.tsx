import { AlertCircle, CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocale } from '../../../hooks/useLocale'
import { wikiApi } from '../../../lib/api/wiki'
import type { WikiWriteQueueItem, WikiWriteQueueState } from '../../../lib/contracts/wiki'

const STATUS_ICON = {
  queued: Clock,
  running: Loader2,
  completed: CheckCircle2,
  failed: XCircle,
} as const

function statusLabel(status: WikiWriteQueueItem['status'], t: (key: string) => string) {
  switch (status) {
    case 'queued': return t('wikiWriteQueueStatusQueued')
    case 'running': return t('wikiWriteQueueStatusRunning')
    case 'completed': return t('wikiWriteQueueStatusCompleted')
    case 'failed': return t('wikiWriteQueueStatusFailed')
  }
}

function statusClass(status: WikiWriteQueueItem['status']) {
  switch (status) {
    case 'queued': return 'text-muted-foreground/60'
    case 'running': return 'text-primary'
    case 'completed': return 'text-emerald-600'
    case 'failed': return 'text-destructive'
  }
}

export default function WikiWriteQueuePanel({ snapshotId }: { snapshotId: string }) {
  const { t } = useLocale()
  const [state, setState] = useState<WikiWriteQueueState | null>(null)

  useEffect(() => {
    let cancelled = false

    async function poll() {
      try {
        const next = await wikiApi.getWriteQueue(snapshotId)
        if (!cancelled) setState(next)
      } catch {
        // ignore transient poll errors
      }
    }

    void poll()
    const timer = setInterval(poll, 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [snapshotId])

  if (!state || state.items.length === 0) {
    return (
      <div className="px-3 py-2 border-b border-border/20 text-[10px] text-muted-foreground/50">
        {t('wikiWriteQueueEmpty')}
      </div>
    )
  }

  const running = state.runningCount
  const max = state.concurrency

  return (
    <div className="border-b border-primary/10 bg-primary/[0.03]">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/10">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
          {t('wikiWriteQueueTitle')}
        </span>
        <span className="text-[10px] text-muted-foreground/60">
          {t('wikiWriteQueueConcurrency', { running: String(running), max: String(max) })}
        </span>
      </div>
      <div className="max-h-[160px] overflow-y-auto px-2 py-1.5 space-y-0.5">
        {state.items.map(item => {
          const Icon = STATUS_ICON[item.status]
          const spinning = item.status === 'running'
          return (
            <div
              key={item.id}
              className="flex items-start gap-1.5 rounded-md px-1.5 py-1 hover:bg-card/40"
              title={item.error ?? undefined}
            >
              <Icon
                size={11}
                className={`shrink-0 mt-0.5 ${statusClass(item.status)} ${spinning ? 'animate-spin' : ''}`}
              />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] text-foreground/80 truncate">{item.documentTitle}</p>
                <p className={`text-[9px] ${statusClass(item.status)}`}>
                  {statusLabel(item.status, t)}
                </p>
              </div>
              {item.status === 'failed' && item.error && (
                <AlertCircle size={10} className="shrink-0 text-destructive/70 mt-0.5" />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
