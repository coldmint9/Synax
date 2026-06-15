import { CheckCircle2, Loader2, Sparkles } from 'lucide-react'
import WikiProgressBar from './WikiProgressBar'
import { useLocale } from '../../../hooks/useLocale'

export default function WikiOutlineReady({
  approving,
  disabled,
  onApprove,
}: {
  approving: boolean
  disabled: boolean
  onApprove: () => void
}) {
  const { t } = useLocale()
  const tip = approving ? t('wikiApprovingOutline') : t('wikiOutlineReady')

  return (
    <div className="flex flex-col gap-2 border-b border-success/10 bg-success/5 px-3 py-2">
      <div className="flex items-center gap-2">
        {approving ? (
          <Loader2 size={11} className="shrink-0 animate-spin text-success" />
        ) : (
          <CheckCircle2 size={11} className="shrink-0 text-success" />
        )}
        <span className="min-w-0 flex-1 truncate text-[11px] text-success">
          {tip}
        </span>
        {!approving && (
          <button
            type="button"
            onClick={onApprove}
            disabled={disabled}
            className="wh-pill-btn wh-pill-btn--primary wh-pill-btn--sm"
          >
            <Sparkles size={10} />
            {t('wikiApproveOutline')}
          </button>
        )}
      </div>
      {approving && (
        <WikiProgressBar
          aria-label={tip}
          isIndeterminate
          color="success"
        />
      )}
    </div>
  )
}
