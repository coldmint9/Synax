import { Loader2, Pause } from 'lucide-react'
import WikiProgressBar from './WikiProgressBar'
import { useLocale } from '../../../hooks/useLocale'

export default function WikiWritingProgress({
  done,
  total,
  pausing,
  onPause,
}: {
  done: number
  total: number
  pausing: boolean
  onPause: () => void
}) {
  const { t } = useLocale()
  const hasKnownProgress = total > 0 && !pausing

  return (
    <div className="flex flex-col gap-2 border-b border-primary/10 bg-primary/5 px-3 py-2">
      <div className="flex items-center gap-2">
        <Loader2 size={11} className="shrink-0 animate-spin text-primary" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-primary">
          {t('wikiWritingLabel')}
        </span>
        <button
          type="button"
          onClick={onPause}
          disabled={pausing}
          className="wh-pill-btn wh-pill-btn--soft wh-pill-btn--sm"
        >
          {pausing ? (
            <Loader2 size={10} className="animate-spin" />
          ) : (
            <Pause size={10} />
          )}
          {pausing ? t('wikiPausingGeneration') : t('wikiPauseGeneration')}
        </button>
      </div>
      <WikiProgressBar
        aria-label={t('wikiWritingProgress', { done, total })}
        isIndeterminate={!hasKnownProgress}
        value={hasKnownProgress ? Math.min(100, Math.round((done / total) * 100)) : undefined}
        color="accent"
      />
    </div>
  )
}
