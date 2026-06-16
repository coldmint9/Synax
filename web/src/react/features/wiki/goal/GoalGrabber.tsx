interface Props {
  hasPendingGoals?: boolean
  onClick?: () => void
}

export function GoalGrabber({ hasPendingGoals, onClick }: Props) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`goal-dock-grabber shrink-0 ${hasPendingGoals ? 'goal-dock-grabber--amber' : ''} ${onClick ? 'cursor-pointer hover:opacity-80' : ''}`}
      aria-label={onClick ? 'Collapse' : undefined}
      aria-hidden={onClick ? undefined : true}
    />
  )
}
