import { useEffect, useMemo, useRef } from 'react'
import { Popover, useOverlayState } from '@heroui/react'
import type { ReasoningEffort } from '../../../../lib/api/agentRuntime'
import { REASONING_EFFORT_LABELS } from '../../settings/lib/providerPresets'

export type GoalReasoningEffort = ReasoningEffort

const FALLBACK = 'high'

/* Light Morandi green accent — sourced from the global CSS vars in index.css. */
const ACCENT_TOP = 'var(--radio-accent-top, #b9cdbf)'
const ACCENT_BOTTOM = 'var(--radio-accent-bottom, #a1bba8)'
const ACCENT_TEXT = 'var(--radio-accent-text, #2f3d34)'
const TEXT_DEFAULT = 'var(--radio-idle-text, #52605a)'

interface Props {
  effort: ReasoningEffort
  allowed?: ReasoningEffort[]
  onChange: (effort: ReasoningEffort) => void
  disabled?: boolean
  onOverlayOpenChange?: (open: boolean) => void
}

export function GoalEffortPicker({ effort, allowed, onChange, disabled, onOverlayOpenChange }: Props) {
  const state = useOverlayState({ onOpenChange: onOverlayOpenChange })
  const lastEffortRef = useRef(effort)

  const levels = useMemo<ReasoningEffort[]>(
    () => (allowed && allowed.length > 0 ? allowed : ['low', 'medium', 'high', 'xhigh', 'max']),
    [allowed],
  )

  // When the popover opens, normalize the current choice to one of the allowed levels.
  useEffect(() => {
    if (!state.isOpen) return
    const current = lastEffortRef.current
    if (levels.includes(current)) return
    const fallback: ReasoningEffort = levels.includes(FALLBACK) ? FALLBACK : (levels[0] ?? 'high')
    if (fallback !== current) {
      onChange(fallback)
    }
  }, [state.isOpen, levels, onChange])

  useEffect(() => {
    lastEffortRef.current = effort
  }, [effort])

  const activeEffort: ReasoningEffort = levels.includes(effort)
    ? effort
    : levels.includes(FALLBACK)
      ? FALLBACK
      : (levels[0] ?? 'high')
  const idx = Math.max(0, levels.indexOf(activeEffort))
  const count = levels.length
  const thumbLeft = `calc(${(idx / count) * 100}% + 4px)`
  const thumbWidth = `calc(${100 / count}% - 8px)`

  return (
    <Popover
      isOpen={disabled ? false : state.isOpen}
      onOpenChange={(open) => {
        if (disabled) return
        state.setOpen(open)
      }}
    >
      <Popover.Trigger
        aria-label="思考强度"
        aria-disabled={Boolean(disabled)}
        className={`goal-dock-composer-chip inline-flex h-7 max-w-[7rem] shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] font-normal text-muted-foreground${
          disabled ? ' pointer-events-none opacity-50' : ''
        }`}
      >
        <span className="shrink-0 opacity-70">思考</span>
        <span className="truncate font-medium text-foreground/80">{REASONING_EFFORT_LABELS[activeEffort]}</span>
        <span className="text-[8px] opacity-60">▾</span>
      </Popover.Trigger>
      <Popover.Content placement="top end" offset={8} className="z-50 w-[22rem] overflow-hidden rounded-2xl p-0">
        <div className="px-4 pb-4 pt-3">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">思考强度</span>
            <span
              className="rounded-full px-2.5 py-0.5 text-[10px] font-semibold"
              style={{
                color: ACCENT_TEXT,
                background: `linear-gradient(180deg, ${ACCENT_TOP}, ${ACCENT_BOTTOM})`,
                boxShadow: '0 1px 2px rgba(60, 82, 68, 0.18)',
              }}
            >
              {REASONING_EFFORT_LABELS[activeEffort]}
            </span>
          </div>

          {/* Codex-style animated effort slider */}
          <div
            role="radiogroup"
            aria-label="思考强度"
            className="relative flex h-10 items-center rounded-full p-1"
            style={{
              background: 'linear-gradient(180deg, #ffffff, #f4f6f4)',
              border: '1px solid #e3e8e3',
              boxShadow:
                '0 1px 2px rgba(20, 32, 24, 0.06), 0 4px 12px rgba(20, 32, 24, 0.05), inset 0 1px 0 rgba(255,255,255,0.9)',
            }}
          >
            {/* Animated thumb */}
            <span
              aria-hidden
              className="pointer-events-none absolute rounded-full transition-all duration-300"
              style={{
                top: 4,
                bottom: 4,
                left: thumbLeft,
                width: thumbWidth,
                background: `linear-gradient(180deg, ${ACCENT_TOP}, ${ACCENT_BOTTOM})`,
                boxShadow:
                  '0 2px 4px rgba(60, 84, 68, 0.28), 0 1px 2px rgba(60, 84, 68, 0.18), inset 0 1px 0 rgba(255,255,255,0.65)',
                transitionTimingFunction: 'cubic-bezier(0.34, 0.9, 0.4, 1)',
                transform: 'translateZ(0)',
              }}
            />
            {levels.map(level => {
              const selected = level === activeEffort
              return (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => {
                    if (!selected) onChange(level)
                    state.close()
                  }}
                  className="relative z-10 flex h-full flex-1 items-center justify-center rounded-full text-[12px] font-medium outline-none transition-transform duration-150 select-none"
                  style={{
                    color: selected ? ACCENT_TEXT : TEXT_DEFAULT,
                    transform: selected ? 'scale(1.02)' : 'scale(1)',
                    textShadow: selected ? '0 1px 0 rgba(255,255,255,0.4)' : 'none',
                  }}
                >
                  {REASONING_EFFORT_LABELS[level]}
                </button>
              )
            })}
          </div>

          <p className="mt-2.5 text-center text-[10px] text-muted-foreground/70">
            {allowed && allowed.length > 0
              ? '仅可在此供应商允许的档位中选择'
              : '未限制思考档位，可选择全部强度'}
          </p>
        </div>
      </Popover.Content>
    </Popover>
  )
}
