import { Select, ListBox } from '@heroui/react'
import type { ReactNode, Key } from 'react'

export interface SelectOption {
  key: string
  label: ReactNode
}

interface SettingsSelectProps {
  label?: string
  size?: 'sm' | 'md' | 'lg'
  variant?: 'flat' | 'bordered' | 'faded' | 'underlined'
  className?: string
  fullWidth?: boolean
  selectedKey: string | null
  onSelectionChange: (key: string | null) => void
  disallowEmptySelection?: boolean
  'aria-label'?: string
  options: SelectOption[]
}

export function SettingsSelect({
  label,
  size = 'sm',
  variant = 'bordered',
  className,
  fullWidth,
  selectedKey,
  onSelectionChange,
  disallowEmptySelection,
  'aria-label': ariaLabel,
  options,
}: SettingsSelectProps) {
  return (
    <div className={className}>
      {label && (
        <span className="block text-xs text-foreground pb-1.5">{label}</span>
      )}
      <Select
        size={size}
        variant={variant}
        fullWidth={fullWidth}
        value={selectedKey}
        onChange={(value: Key | null) => {
          onSelectionChange(value ? String(value) : null)
        }}
        disallowEmptySelection={disallowEmptySelection}
        aria-label={ariaLabel ?? label}
      >
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox aria-label={ariaLabel ?? label ?? 'Options'}>
            {options.map(opt => (
              <ListBox.Item key={opt.key} id={opt.key} textValue={typeof opt.label === 'string' ? opt.label : opt.key}>
                {opt.label}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
    </div>
  )
}
