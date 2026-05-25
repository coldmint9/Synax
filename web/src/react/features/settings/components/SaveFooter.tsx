import { Button } from '@heroui/react'
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
      <Button size="sm" color="primary" isLoading={saving} onPress={onSave}
        startContent={!saving ? <Save size={13} /> : undefined}
      >
        {saveLabel ?? t('commonSave')}
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
