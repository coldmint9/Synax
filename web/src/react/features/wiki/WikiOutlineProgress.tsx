import { useEffect, useState } from 'react'
import { Loader2, Search, FileCode, Users, Brain, Send } from 'lucide-react'
import { useLocale } from '../../../hooks/useLocale'
import type { OutlineActivity, OutlineActivityPhase } from '../../../hooks/useWikiGenerationEvents'

const PHASE_ICONS: Record<OutlineActivityPhase, typeof Search> = {
  scan: Search,
  explore: FileCode,
  delegate: Users,
  synthesize: Brain,
  submit: Send,
}

interface Props {
  activities: OutlineActivity[]
  currentActivity: string | null
  phase: string | null
}

export default function WikiOutlineProgress({ activities, currentActivity, phase }: Props) {
  const { t } = useLocale()
  const [elapsed, setElapsed] = useState(0)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    const timer = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const ss = String(elapsed % 60).padStart(2, '0')

  const isActive = phase !== 'outline_ready' && phase !== 'ready' && phase !== 'failed'
  const recentActivities = activities.slice(-8)

  return (
    <div className="flex flex-col border-b border-primary/10 bg-primary/[0.02]">
      {/* ── Current activity bar ── */}
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex items-center justify-between px-3 py-1.5 hover:bg-primary/[0.04] transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          {isActive ? (
            <Loader2 size={11} className="animate-spin text-primary shrink-0" />
          ) : (
            <Send size={11} className="text-emerald-500 shrink-0" />
          )}
          <span className="text-[11px] text-primary/80 truncate">
            {currentActivity ?? t('wikiPhaseAgentAnalyzing')}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 ml-2">
          {isActive && (
            <span className="text-[10px] font-mono text-muted-foreground/30 tabular-nums">{mm}:{ss}</span>
          )}
          {recentActivities.length > 0 && (
            <span className="text-[9px] text-muted-foreground/25 tabular-nums">{recentActivities.length}</span>
          )}
        </div>
      </button>

      {/* ── Activity log (collapsible via click on bar) ── */}
      {expanded && recentActivities.length > 0 && (
        <div className="px-3 pb-1.5 max-h-[120px] overflow-y-auto">
          <div className="space-y-0.5">
            {recentActivities.map((a, i) => {
              const Icon = PHASE_ICONS[a.phase] ?? FileCode
              return (
                <div key={i} className="flex items-center gap-1.5 text-[10px] text-muted-foreground/50">
                  <Icon size={10} className="shrink-0 text-primary/30" />
                  <span className="truncate">{a.activity}</span>
                  {a.detail && (
                    <span className="text-[9px] text-muted-foreground/20 truncate hidden sm:inline font-mono">
                      {a.detail}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
