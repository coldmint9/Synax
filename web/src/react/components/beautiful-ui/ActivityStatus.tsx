// Adapted from Beautiful UI TaskRows (MIT, copyright 2026 Shane Levine).
// Source: slev12397/beautiful-ui @ ff0f74d. License: web/public/licenses/beautiful-ui.txt.
// Only the presentation is reused; status always comes from Synax.
import { Archive, Ban, Check, Circle, Clock3, LoaderCircle, ShieldAlert, X } from 'lucide-react'
import { useLocale } from '../../../hooks/useLocale'
import type { I18nKey } from '../../../lib/i18n'

const STATES: Record<string, { icon: typeof Check; label: I18nKey; tone: string }> = {
  running: { icon: LoaderCircle, label: 'activityStatusRunning', tone: 'active' },
  completed: { icon: Check, label: 'activityStatusCompleted', tone: 'success' },
  failed: { icon: X, label: 'activityStatusFailed', tone: 'danger' },
  denied: { icon: ShieldAlert, label: 'activityStatusDenied', tone: 'warning' },
  waiting_permission: { icon: ShieldAlert, label: 'activityStatusPermission', tone: 'warning' },
  waiting_input: { icon: Clock3, label: 'activityStatusInput', tone: 'warning' },
  interrupted: { icon: Ban, label: 'activityStatusInterrupted', tone: 'warning' },
  cancelled: { icon: Ban, label: 'activityStatusCancelled', tone: 'muted' },
  compacted: { icon: Archive, label: 'activityStatusCompacted', tone: 'muted' },
  queued: { icon: Clock3, label: 'activityStatusQueued', tone: 'muted' },
  pending: { icon: Circle, label: 'activityStatusPending', tone: 'muted' },
  idle: { icon: Circle, label: 'activityStatusIdle', tone: 'muted' },
}

export function ActivityStatus({ status, compact = false }: { status: string; compact?: boolean }) {
  const { t } = useLocale()
  const state = STATES[status]
  const Icon = state?.icon ?? Circle
  const label = state ? t(state.label) : status

  return (
    <span
      className="bui-status"
      data-tone={state?.tone ?? 'muted'}
      data-state={status}
      data-compact={compact || undefined}
      title={label}
      aria-label={compact ? label : undefined}
    >
      <Icon size={12} strokeWidth={1.8} aria-hidden="true" className={status === 'running' ? 'bui-status-spinner' : undefined} />
      {!compact && <span>{label}</span>}
    </span>
  )
}
