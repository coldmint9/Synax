import { Loader2, Pause } from 'lucide-react'
import WikiProgressBar from './WikiProgressBar'
import { useLocale } from '../../../hooks/useLocale'
import type { WikiGenProgressCounts } from './wikiWritingProgressCounts'
import { resolveWikiWritingProgressCounts } from './wikiWritingProgressCounts'
import type { WikiDocument } from '../../../lib/contracts/wiki'

export default function WikiWritingProgress({
  documents,
  genProgress,
  pausing,
  onPause,
}: {
  documents: WikiDocument[]
  genProgress?: WikiGenProgressCounts | null
  pausing: boolean
  onPause: () => void
}) {
  const { t } = useLocale()
  const { done, total, percent } = resolveWikiWritingProgressCounts(documents, genProgress)
  const hasKnownProgress = total > 0 && !pausing
  const currentDoc = genProgress?.docTitle

  return (
    <div className="flex flex-col gap-2 border-b border-primary/10 bg-primary/5 px-3 py-2">
      <div className="flex items-center gap-2">
        <Loader2 size={11} className="shrink-0 animate-spin text-primary" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-primary">
          {currentDoc
            ? t('wikiWritingCurrentDoc', { title: currentDoc, done, total })
            : t('wikiWriting', { done, total })}
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
        done={hasKnownProgress ? done : undefined}
        total={hasKnownProgress ? total : undefined}
        value={hasKnownProgress ? percent : undefined}
        isIndeterminate={!hasKnownProgress}
        color="accent"
      />
    </div>
  )
}
