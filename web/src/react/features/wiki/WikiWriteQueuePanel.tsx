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

const POLL_INTERVAL_MS = 30_000

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

export default function WikiWriteQueuePanel({
  snapshotId,
  refreshKey = 0,
}: {
  snapshotId: string
  refreshKey?: number
}) {
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
    const timer = setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [snapshotId, refreshKey])

  if (!state || state.items.length === 0) {
    return (
      <div className="px-3 py-2 border-b border-border/20 text-[10px] text-muted-foreground/50">
        {t('wikiWriteQueueEmpty')}
      </div>
    )
  }

  return (
    <div className="border-b border-border/20">
      <div className="flex items-center justify-between px-3 py-1.5 text-[10px] text-muted-foreground/60">
        <span>{t('wikiWriteQueueTitle')}</span>
        <span>{t('wikiWriteQueueConcurrency', { running: state.runningCount, max: state.concurrency })}</span>
      </div>
      {state.rateLimited && state.queuedCount > 0 && (
        <div className="mx-3 mb-2 flex items-start gap-1.5 rounded-md border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-[10px] text-amber-700">
          <AlertCircle size={11} className="mt-0.5 shrink-0" />
          <span>{t('wikiWriteQueueRateLimited')}</span>
        </div>
      )}
      <ul className="max-h-40 overflow-y-auto px-2 pb-2 space-y-0.5">
        {state.items.map((item) => {
          const Icon = STATUS_ICON[item.status]
          return (
            <li
              key={item.id}
              className={`flex items-center gap-2 rounded px-1.5 py-1 text-[10px] ${statusClass(item.status)}`}
            >
              <Icon size={11} className={item.status === 'running' ? 'animate-spin' : ''} />
              <span className="truncate flex-1">{item.documentTitle}</span>
              <span className="shrink-0 opacity-70">{statusLabel(item.status, t)}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
