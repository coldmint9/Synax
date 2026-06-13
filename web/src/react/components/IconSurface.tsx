import type { ReactNode } from 'react'
import { iconSurfaceClass, type IconSurfaceSize, type IconTone } from '../../lib/icon-tones'
import { cn } from '../../lib/utils'

interface IconSurfaceProps {
  tone: IconTone
  size?: IconSurfaceSize
  className?: string
  children: ReactNode
}

export function IconSurface({ tone, size = 'sm', className, children }: IconSurfaceProps) {
  return (
    <span className={cn(iconSurfaceClass(tone, size), className)} data-tone={tone} data-size={size}>
      {children}
    </span>
  )
}
