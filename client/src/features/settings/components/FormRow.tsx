import type { ReactNode } from 'react'

interface FormRowProps {
  label: string
  description?: string
  children: ReactNode
}

export function FormRow({ label, description, children }: FormRowProps) {
  return (
    <div className="settings-row">
      <div className="min-w-0 flex-1">
        <div className="settings-row__label">{label}</div>
        {description && (
          <div className="settings-row__description">{description}</div>
        )}
      </div>
      <div className="settings-row__control">{children}</div>
    </div>
  )
}
