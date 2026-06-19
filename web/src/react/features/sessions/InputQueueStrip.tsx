import { ArrowUp, X } from 'lucide-react'
import type { QueuedInput } from '../../../lib/api/agentRuntime'
import { useLocale } from '../../../hooks/useLocale'

interface Props {
  items: QueuedInput[]
  onRemove: (itemId: string) => void
  onForce: (itemId: string) => void
}

function previewMessage(message: string, max = 56): string {
  const trimmed = message.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max - 1)}…`
}

export function InputQueueStrip({ items, onRemove, onForce }: Props) {
  const { t } = useLocale()
  if (items.length === 0) return null

  return (
    <div className="input-queue-strip mb-1.5 w-[min(100%,20rem)] self-center">
      <div className="input-queue-strip-header mb-1 flex items-center justify-between px-1 text-[10px] text-muted-foreground/70">
        <span>{t('inputQueueTitle', { count: items.length })}</span>
      </div>
      <ul className="input-queue-strip-list flex flex-col gap-1">
        {items.map((item) => (
          <li
            key={item.id}
            className="input-queue-strip-item flex items-center gap-1.5 rounded-full border border-border/50 bg-surface/80 px-2.5 py-1 text-[11px] text-foreground/85 backdrop-blur-sm"
          >
            <span className="min-w-0 flex-1 truncate" title={item.message}>
              {previewMessage(item.message)}
            </span>
            <button
              type="button"
              aria-label={t('inputQueueForce')}
              className="input-queue-strip-btn inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
              onClick={() => onForce(item.id)}
            >
              <ArrowUp size={12} />
            </button>
            <button
              type="button"
              aria-label={t('inputQueueRemove')}
              className="input-queue-strip-btn inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              onClick={() => onRemove(item.id)}
            >
              <X size={12} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
