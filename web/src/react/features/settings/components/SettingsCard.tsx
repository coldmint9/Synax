import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

interface SettingsCardProps {
  title: string
  description?: string
  icon?: LucideIcon
  trailing?: ReactNode
  badge?: ReactNode
  children: ReactNode
}

export function SettingsCard({ title, description, icon: Icon, trailing, badge, children }: SettingsCardProps) {
  return (
    <section className="settings-section">
      <header className="settings-section__header">
        <div className="settings-section__heading">
          {Icon && <Icon size={14} className="settings-section__icon" />}
          <span className="settings-section__title">{title}</span>
          {badge}
        </div>
        {(description || trailing) && (
          <div className="settings-section__meta">
            {description && <span>{description}</span>}
            {trailing}
          </div>
        )}
      </header>
      <div className="settings-section__body">{children}</div>
    </section>
  )
}
