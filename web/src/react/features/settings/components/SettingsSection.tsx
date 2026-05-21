import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

interface SettingsSectionProps {
  title: string
  icon?: LucideIcon
  children: ReactNode
  badge?: ReactNode
  trailing?: ReactNode
}

export function SettingsSection({ title, icon: Icon, children, badge, trailing }: SettingsSectionProps) {
  return (
    <section className="rounded-xl border border-border/40 bg-card/80 p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          {Icon && <Icon size={15} className="text-muted-foreground" />}
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {badge}
        </div>
        {trailing}
      </div>
      {children}
    </section>
  )
}
