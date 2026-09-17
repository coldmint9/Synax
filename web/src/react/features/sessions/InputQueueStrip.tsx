import { useEffect, useState } from 'react'
import { ListStart, Paperclip, X } from 'lucide-react'
import type { QueuedInput } from '../../../lib/api/agentRuntime'
import type { RuntimeContentPart } from '../../../lib/api/runtimeMedia'
import { runtimeMedia } from '../../../lib/api/runtimeMedia'
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

const MAX_VISIBLE_THUMBS = 3

function QueueMediaThumb({ assetId }: { assetId: string }) {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl: string | undefined
    void runtimeMedia
      .blob(assetId, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch(() => {})
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [assetId])
  if (!url)
    return (
      <span className="queue-media-thumb inline-flex size-5 shrink-0 items-center justify-center rounded bg-muted/70 text-muted-foreground">
        <Paperclip size={10} aria-hidden />
      </span>
    )
  return (
    <img
      src={url}
      alt=""
      className="queue-media-thumb size-5 shrink-0 rounded object-cover ring-1 ring-border/50"
    />
  )
}

function QueueMediaIndicators({ parts }: { parts?: RuntimeContentPart[] }) {
  const media = parts?.filter((p) => p.type !== 'text')
  if (!media?.length) return null
  const images = media.filter((p) => p.type === 'image')
  const files = media.length - images.length
  return (
    <span className="flex shrink-0 items-center gap-1">
      {images.slice(0, MAX_VISIBLE_THUMBS).map((p, i) => (
        <QueueMediaThumb key={`${p.assetId}-${i}`} assetId={p.assetId} />
      ))}
      {images.length > MAX_VISIBLE_THUMBS && (
        <span className="text-[10px] tabular-nums text-muted-foreground">
          +{images.length - MAX_VISIBLE_THUMBS}
        </span>
      )}
      {files > 0 && (
        <span className="inline-flex h-5 items-center gap-0.5 rounded-full bg-muted/70 px-1.5 text-[10px] tabular-nums text-muted-foreground">
          <Paperclip size={10} aria-hidden />
          {files}
        </span>
      )}
    </span>
  )
}

export function InputQueueStrip({ items, onRemove, onForce }: Props) {
  const { t } = useLocale()
  if (items.length === 0) return null

  return (
    <div className="input-queue-strip pointer-events-auto mb-1.5 w-full min-w-0">
      <div className="input-queue-strip-header mb-1 flex items-center justify-between px-1 text-[10px] text-muted-foreground/70">
        <span>{t('inputQueueTitle', { count: items.length })}</span>
      </div>
      <ul className="input-queue-strip-list flex max-h-32 flex-col gap-1 overflow-y-auto overscroll-contain">
        {items.map((item) => (
          <li
            key={item.id}
            className="input-queue-strip-item flex shrink-0 items-center gap-1.5 rounded-full border border-border/50 bg-surface/80 px-2.5 py-1 text-[11px] text-foreground/85 backdrop-blur-sm"
          >
            <span className="min-w-0 flex-1 truncate" title={item.message}>
              {previewMessage(item.message)}
            </span>
            <QueueMediaIndicators parts={item.contentParts} />
            <button
              type="button"
              aria-label={t('inputQueueForce')}
              title={t('inputQueueForce')}
              className="input-queue-strip-btn inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
              onClick={() => onForce(item.id)}
            >
              <ListStart size={12} aria-hidden />
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
