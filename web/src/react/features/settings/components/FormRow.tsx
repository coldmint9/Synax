import type { ReactNode } from 'react'

interface FormRowProps {
  label: string
  description?: string
  children: ReactNode
}

export function FormRow({ label, description, children }: FormRowProps) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-foreground">{label}</div>
        {description && (
          <div className="text-[11px] text-muted-foreground">{description}</div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}
