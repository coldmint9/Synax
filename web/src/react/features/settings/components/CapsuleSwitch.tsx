interface CapsuleSwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  label?: string
}

export function CapsuleSwitch({ checked, onChange, disabled, label }: CapsuleSwitchProps) {
  return (
    <label className={`capsule-switch-wrapper${disabled ? ' opacity-50 pointer-events-none' : ''}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className="capsule-switch"
        data-checked={checked || undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="capsule-switch-thumb" />
      </button>
      {label && <span className="text-xs text-foreground">{label}</span>}
    </label>
  )
}
