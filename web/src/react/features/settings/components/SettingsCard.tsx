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
    <section className="wiki-workbench-card overflow-hidden rounded-[14px]">
      <header className="flex flex-row items-center justify-between gap-2 border-b wiki-soft-rule px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {Icon && <Icon size={15} className="shrink-0 text-primary/70" />}
          <span className="text-sm font-semibold text-foreground">{title}</span>
          {badge}
        </div>
        {(description || trailing) && (
          <div className="flex items-center gap-3">
            {description && <span className="text-[11px] text-muted-foreground">{description}</span>}
            {trailing}
          </div>
        )}
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  )
}
