import { ProgressBar } from '@heroui/react'

type WikiProgressBarProps = {
  'aria-label': string
  value?: number
  isIndeterminate?: boolean
  color?: 'accent' | 'success' | 'warning' | 'danger'
  className?: string
}

/** HeroUI v3 ProgressBar requires Track + Fill children to render the bar. */
export default function WikiProgressBar({
  'aria-label': ariaLabel,
  value,
  isIndeterminate,
  color = 'accent',
  className = 'w-full',
}: WikiProgressBarProps) {
  return (
    <ProgressBar
      aria-label={ariaLabel}
      value={isIndeterminate ? undefined : value}
      isIndeterminate={isIndeterminate}
      size="sm"
      color={color}
      className={className}
    >
      <ProgressBar.Track>
        <ProgressBar.Fill />
      </ProgressBar.Track>
    </ProgressBar>
  )
}
