import type { ReactNode } from 'react'
import { InfoTooltip } from '@/shared/ui/ui/InfoTooltip'
import { useLocale } from '../../../shared/hooks/useLocale'

interface FormRowProps {
  label: string
  description?: string
  children: ReactNode
}

export function FormRow({ label, description, children }: FormRowProps) {
  const { locale } = useLocale()
  return (
    <div className="settings-row">
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <div className="settings-row__label">{label}</div>
        {description && (
          <InfoTooltip label={locale === 'zh' ? `${label}说明` : `About ${label}`}>{description}</InfoTooltip>
        )}
      </div>
      <div className="settings-row__control">{children}</div>
    </div>
  )
}
