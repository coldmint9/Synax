interface Props {
  label: string
  hovered?: boolean
  onClick: () => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}

export function GoalPromptPill({
  label,
  hovered = false,
  onClick,
  onMouseEnter,
  onMouseLeave,
}: Props) {
  return (
    <button
      type="button"
      className={`goal-dock-mini-inner flex h-full w-full items-center gap-2 px-3 text-[11px] transition-all duration-150 ${
        hovered ? 'goal-dock-mini-inner--hover' : ''
      }`}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      aria-label={label}
    >
      <span className="min-w-0 flex-1 truncate text-center text-muted-foreground/80 italic">
        {label}
      </span>
      <span className={`shrink-0 text-[9px] transition-transform duration-150 ${hovered ? 'text-muted-foreground/70' : 'text-muted-foreground/40'}`}>
        ▲
      </span>
    </button>
  )
}
