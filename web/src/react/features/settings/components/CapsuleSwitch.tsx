import { Switch } from '@heroui/react'

interface CapsuleSwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  label?: string
}

export function CapsuleSwitch({ checked, onChange, disabled, label }: CapsuleSwitchProps) {
  return (
    <Switch
      size="sm"
      isSelected={checked}
      onChange={onChange}
      isDisabled={disabled}
      aria-label={label}
    >
      {label && <span className="text-xs text-foreground">{label}</span>}
    </Switch>
  )
}
