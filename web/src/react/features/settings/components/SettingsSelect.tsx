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
  selectedKeys: string[]
  onSelectionChange: (keys: Set<string>) => void
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
  selectedKeys,
  onSelectionChange,
  disallowEmptySelection,
  'aria-label': ariaLabel,
  options,
}: SettingsSelectProps) {
  const currentKey = selectedKeys[0] ?? null
  return (
    <Select
      size={size}
      variant={variant}
      className={className}
      fullWidth={fullWidth}
      selectedKey={currentKey}
      onSelectionChange={(key: Key | null) => {
        if (key != null) onSelectionChange(new Set([String(key)]))
      }}
      disallowEmptySelection={disallowEmptySelection}
      aria-label={ariaLabel ?? label}
    >
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map(opt => (
            <ListBox.Item key={opt.key} id={opt.key} textValue={typeof opt.label === 'string' ? opt.label : opt.key}>
              {opt.label}
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  )
}
