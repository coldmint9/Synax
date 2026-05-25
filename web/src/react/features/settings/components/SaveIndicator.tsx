import { Check, Loader2 } from 'lucide-react'
import { useLocale } from '../../../../hooks/useLocale'

interface SaveIndicatorProps {
  saving: boolean
  saved: boolean
  error?: string | null
}

export function SaveIndicator({ saving, saved, error }: SaveIndicatorProps) {
  const { t } = useLocale()
  if (error) {
    return <span className="text-[11px] text-destructive">{error}</span>
  }
  if (saving) {
    return <Loader2 size={12} className="animate-spin text-muted-foreground" />
  }
  if (saved) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[11px] text-success animate-fade-up">
        <Check size={11} />
        {t('commonSaved')}
      </span>
    )
  }
  return null
}
