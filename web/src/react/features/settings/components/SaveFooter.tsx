import { Button, Spinner } from '@heroui/react'
import { Check, Save } from 'lucide-react'
import { useLocale } from '../../../../hooks/useLocale'

interface SaveFooterProps {
  saving: boolean
  saved: boolean
  error?: string | null
  onSave: () => void
  saveLabel?: string
}

export function SaveFooter({ saving, saved, error, onSave, saveLabel }: SaveFooterProps) {
  const { t } = useLocale()
  return (
    <div className="flex items-center gap-3 pt-4 border-t border-border/30">
      <Button size="sm" isPending={saving} onPress={onSave}>
        {({ isPending }) => (
          <>
            {isPending ? <Spinner color="current" size="sm" /> : <Save size={13} />}
            {saveLabel ?? t('commonSave')}
          </>
        )}
      </Button>
      {saved && (
        <span className="inline-flex items-center gap-1 text-xs text-success animate-fade-up">
          <Check size={13} /> {t('commonSaved')}
        </span>
      )}
      {error && <span className="text-[11px] text-destructive">{error}</span>}
    </div>
  )
}
