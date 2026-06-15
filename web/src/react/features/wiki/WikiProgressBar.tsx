import { ProgressBar } from '@heroui/react'

type WikiProgressBarProps = {
  'aria-label': string
  done?: number
  total?: number
  value?: number
  isIndeterminate?: boolean
  color?: 'accent' | 'success' | 'warning' | 'danger'
  className?: string
}

/** HeroUI v3 ProgressBar requires Track + Fill children to render the bar. */
export default function WikiProgressBar({
  'aria-label': ariaLabel,
  done,
  total,
  value,
  isIndeterminate,
  color = 'accent',
  className = 'w-full',
}: WikiProgressBarProps) {
  const showCount = done != null && total != null && total > 0
  const fillValue = isIndeterminate
    ? undefined
    : (value ?? (showCount ? Math.min(100, Math.round((done / total) * 100)) : undefined))

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      {showCount && (
        <span className="text-[10px] tabular-nums text-muted-foreground/70">
          {done}/{total}
        </span>
      )}
      <ProgressBar
        aria-label={ariaLabel}
        value={fillValue}
        isIndeterminate={isIndeterminate}
        size="sm"
        color={color}
        className="w-full"
      >
        <ProgressBar.Track>
          <ProgressBar.Fill />
        </ProgressBar.Track>
      </ProgressBar>
    </div>
  )
}
