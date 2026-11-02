import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { InfoTooltip } from '@/shared/ui/ui/InfoTooltip'
import { useLocale } from '../../../shared/hooks/useLocale'

interface SettingsCardProps {
  title: string
  description?: string
  descriptionMode?: 'tooltip' | 'inline'
  icon?: LucideIcon
  trailing?: ReactNode
  badge?: ReactNode
  children: ReactNode
}

export function SettingsCard({ title, description, descriptionMode = 'tooltip', icon: Icon, trailing, badge, children }: SettingsCardProps) {
  const { locale } = useLocale()
  return (
    <section className="settings-section">
      <header className="settings-section__header">
        <div className="settings-section__heading">
          {Icon && <Icon size={14} className="settings-section__icon" />}
          <h2 className="settings-section__title">{title}</h2>
          {badge}
          {description && descriptionMode === 'tooltip' && <InfoTooltip label={locale === 'zh' ? `${title}说明` : `About ${title}`}>{description}</InfoTooltip>}
        </div>
        {trailing && <div className="settings-section__meta">{trailing}</div>}
      </header>
      <div className="settings-section__body">
        {description && descriptionMode === 'inline' && <p className="settings-note">{description}</p>}
        {children}
      </div>
    </section>
  )
}
