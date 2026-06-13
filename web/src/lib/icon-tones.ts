export type IconTone =
  | 'muted'
  | 'primary'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'agent'
  | 'accent'
  | 'purple'
  | 'caution'
  | 'logo'

export type IconSurfaceSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

export function iconSurfaceClass(tone: IconTone, size: IconSurfaceSize = 'sm', extra?: string) {
  return ['icon-surface', extra].filter(Boolean).join(' ')
}

export function iconSurfaceProps(tone: IconTone, size: IconSurfaceSize = 'sm') {
  return {
    className: iconSurfaceClass(tone, size),
    'data-tone': tone,
    'data-size': size,
  } as const
}

export function iconBadgeClass(tone: IconTone, extra?: string) {
  return ['icon-badge', extra].filter(Boolean).join(' ')
}

export function iconBadgeProps(tone: IconTone) {
  return {
    className: iconBadgeClass(tone),
    'data-tone': tone,
  } as const
}
