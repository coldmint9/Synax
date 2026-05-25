import { Card } from '@heroui/react'
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
    <Card variant="secondary">
      <Card.Header className="flex-row items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {Icon && <Icon size={15} className="text-muted-foreground shrink-0" />}
          <span className="text-sm font-semibold text-foreground">{title}</span>
          {badge}
        </div>
        {(description || trailing) && (
          <div className="flex items-center gap-3">
            {description && <span className="text-[11px] text-muted-foreground">{description}</span>}
            {trailing}
          </div>
        )}
      </Card.Header>
      <Card.Content>{children}</Card.Content>
    </Card>
  )
}
