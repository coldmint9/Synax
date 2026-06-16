import { ArrowLeft, Search, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@heroui/react'
import { useLocale } from '../../../hooks/useLocale'
import type { SessionListView } from './sessionBuckets'

interface Props {
  listView: SessionListView
  visibleCount: number
  workflowCount: number
  searchQuery: string
  onSearchChange: (q: string) => void
  onRefresh: () => void
  onClearInactive: () => void
  onOpenWorkflows?: () => void
  onBackToGoals?: () => void
  isRefreshing: boolean
}

export function SessionListHeader({
  listView,
  visibleCount,
  workflowCount,
  searchQuery,
  onSearchChange,
  onRefresh,
  onClearInactive,
  onOpenWorkflows,
  onBackToGoals,
  isRefreshing,
}: Props) {
  const { t } = useLocale()
  const isWorkflowView = listView === 'workflow'

  return (
    <div className="px-3 pt-3 pb-2 border-b border-border/20 space-y-2">
      {isWorkflowView ? (
        <button
          type="button"
          onClick={onBackToGoals}
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft size={12} />
          {t('sessionBackToGoals')}
        </button>
      ) : null}

      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-foreground">
          {isWorkflowView ? t('sessionWorkflowTitle') : t('sessionGoalTitle')}
          <span className="ml-1 font-normal text-muted-foreground">({visibleCount})</span>
        </span>
        <div className="flex items-center gap-0.5">
          <Button isIconOnly variant="ghost" size="sm" className="h-7 w-7 min-w-0 text-muted-foreground" onPress={onRefresh} aria-label="Refresh">
            <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
          </Button>
          <Button isIconOnly variant="ghost" size="sm" className="h-7 w-7 min-w-0 text-muted-foreground hover:text-danger" onPress={onClearInactive} aria-label="Clear inactive sessions">
            <Trash2 size={14} />
          </Button>
        </div>
      </div>

      <div className="relative">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50 pointer-events-none" />
        <input
          type="text"
          value={searchQuery}
          onChange={e => onSearchChange(e.target.value)}
          placeholder={t('sessionSearch')}
          className="w-full h-7 pl-7 pr-2.5 text-[11px] bg-secondary/40 border border-border/30 rounded-md text-foreground placeholder:text-muted-foreground/40 outline-none focus:border-accent/40 focus:bg-secondary/60 transition-colors"
        />
      </div>

      {!isWorkflowView && workflowCount > 0 ? (
        <button
          type="button"
          onClick={onOpenWorkflows}
          className="w-full rounded-md border border-border/30 bg-secondary/20 px-2.5 py-1.5 text-left text-[10px] text-muted-foreground transition-colors hover:border-border/50 hover:bg-secondary/40 hover:text-foreground"
        >
          {t('sessionOpenWorkflows', { count: workflowCount })}
        </button>
      ) : null}
    </div>
  )
}
