import { useEffect, useMemo, useRef } from 'react'
import { ChevronRight, RotateCcw } from 'lucide-react'
import { Popover, useOverlayState } from '@heroui/react'
import type { ReasoningEffort } from '../../../../lib/api/agentRuntime'
import { REASONING_EFFORT_LABELS } from '../../settings/lib/providerPresets'

export type GoalReasoningEffort = ReasoningEffort

const FALLBACK: ReasoningEffort = 'high'
const ALL_LEVELS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/* Light Morandi green accent — sourced from the global CSS vars in index.css. */
const ACCENT_TOP = 'var(--radio-accent-top, #b9cdbf)'
const ACCENT_BOTTOM = 'var(--radio-accent-bottom, #a1bba8)'
const ACCENT_TEXT = 'var(--radio-accent-text, #2f3d34)'

interface Props {
  effort: ReasoningEffort
  allowed?: ReasoningEffort[]
  modelLabel?: string | null
  onChange: (effort: ReasoningEffort) => void
  disabled?: boolean
  onOverlayOpenChange?: (open: boolean) => void
}

export function GoalEffortPicker({ effort, allowed, modelLabel, onChange, disabled, onOverlayOpenChange }: Props) {
  const state = useOverlayState({ onOpenChange: onOverlayOpenChange })
  const lastEffortRef = useRef(effort)

  const levels = useMemo<ReasoningEffort[]>(
    () => (allowed && allowed.length > 0 ? allowed : ALL_LEVELS),
    [allowed],
  )

  // Keep an existing selection valid when the selected provider's allowed set changes.
  useEffect(() => {
    if (!state.isOpen) return
    const current = lastEffortRef.current
    if (levels.includes(current)) return
    const fallback = levels.includes(FALLBACK) ? FALLBACK : (levels[0] ?? FALLBACK)
    if (fallback !== current) onChange(fallback)
  }, [state.isOpen, levels, onChange])

  useEffect(() => {
    lastEffortRef.current = effort
  }, [effort])

  const activeEffort = levels.includes(effort)
    ? effort
    : levels.includes(FALLBACK)
      ? FALLBACK
      : (levels[0] ?? FALLBACK)
  const idx = Math.max(0, levels.indexOf(activeEffort))
  const count = Math.max(1, levels.length)
  // Stations split the track content evenly: dots and thumb share one coordinate
  // system, with a 4px inset at both ends (track padding: p-1).
  const stationFraction = (index: number) => (index + 0.5) / count
  const thumbLeft = `calc(0.25rem + (100% - 0.5rem) * ${stationFraction(idx)})`
  const fillWidth = `calc((100% - 0.5rem) * ${stationFraction(idx)})`
  const modelText = modelLabel?.trim() || '当前模型'

  function resetEffort() {
    const next = levels.includes(FALLBACK) ? FALLBACK : (levels[0] ?? FALLBACK)
    if (next !== effort) onChange(next)
  }

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
        className={`goal-dock-composer-chip inline-flex h-7 max-w-[5.75rem] shrink-0 items-center gap-1 rounded-full px-2 text-[10px] font-normal text-muted-foreground${
          disabled ? ' pointer-events-none opacity-50' : ''
        }`}
      >
        <span className="shrink-0 opacity-70">思考</span>
        <span className="truncate font-medium text-foreground/80">{REASONING_EFFORT_LABELS[activeEffort]}</span>
        <span className="text-[8px] opacity-60">▾</span>
      </Popover.Trigger>
      <Popover.Content placement="top end" offset={8} className="z-50 w-[16rem] overflow-hidden rounded-xl p-0">
        <div className="px-3 pb-3 pt-2.5">
          {/* Compact header: current effort, disclosure chevron, reset affordance. */}
          <div className="relative flex min-h-6 items-center justify-center">
            <div className="flex items-center gap-0.5">
              <span className="text-sm font-medium leading-none" style={{ color: ACCENT_TEXT }}>
                {REASONING_EFFORT_LABELS[activeEffort]}
              </span>
              <ChevronRight size={12} className="text-muted-foreground/75" />
            </div>
            <button
              type="button"
              aria-label="恢复默认思考强度"
              title="恢复默认"
              onClick={resetEffort}
              className="absolute right-0 inline-flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <RotateCcw size={12} />
            </button>
          </div>
          <div className="mt-1 truncate text-center text-[10px] leading-4 text-muted-foreground" title={modelText}>
            {modelText}
          </div>

          {/* Compact slider: green progress, white 3D thumb, and station dots. */}
          <div
            role="radiogroup"
            aria-label="思考强度"
            className="relative mt-2.5 flex h-8 items-center rounded-full p-1"
            style={{
              background: '#e3e4e4',
              border: '1px solid #d1d3d3',
              boxShadow: 'inset 0 1px 2px rgba(30, 36, 32, 0.06), 0 1px 1px rgba(30, 36, 32, 0.04)',
            }}
          >
            <span
              aria-hidden
              className="pointer-events-none absolute left-1 top-1 bottom-1 rounded-full transition-[width] duration-300"
              style={{
                width: fillWidth,
                background: `linear-gradient(180deg, ${ACCENT_TOP}, ${ACCENT_BOTTOM})`,
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.45)',
                transitionTimingFunction: 'cubic-bezier(0.34, 0.9, 0.4, 1)',
              }}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute top-1/2 z-20 size-7 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white transition-[left] duration-300"
              style={{
                left: thumbLeft,
                boxShadow: '0 2px 5px rgba(43, 54, 47, 0.22), 0 0 0 1px rgba(43,54,47,0.08), inset 0 1px 0 rgba(255,255,255,0.95)',
                transitionTimingFunction: 'cubic-bezier(0.34, 0.9, 0.4, 1)',
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
                  aria-label={REASONING_EFFORT_LABELS[level]}
                  onClick={() => {
                    // Keep the card open after changing intensity, like Codex.
                    if (!selected) onChange(level)
                  }}
                  className="relative z-30 flex h-full flex-1 items-center justify-center rounded-full outline-none select-none"
                >
                  <span
                    aria-hidden
                    className="size-1.5 rounded-full transition-colors duration-200"
                    style={{
                      background: selected ? ACCENT_TOP : '#aeb1b0',
                      opacity: selected ? 0.95 : 0.9,
                    }}
                  />
                </button>
              )
            })}
          </div>

          <p className="mt-1.5 text-center text-[10px] text-muted-foreground/70">
            {allowed && allowed.length > 0
              ? '仅可在此供应商允许的档位中选择'
              : '未限制思考档位，可选择全部强度'}
          </p>
        </div>
      </Popover.Content>
    </Popover>
  )
}
