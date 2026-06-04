import { Search, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@heroui/react'

interface Props {
  totalCount: number
  searchQuery: string
  onSearchChange: (q: string) => void
  onRefresh: () => void
  onClearInactive: () => void
  isRefreshing: boolean
}

export function SessionListHeader({
  totalCount, searchQuery, onSearchChange, onRefresh, onClearInactive, isRefreshing,
}: Props) {
  return (
    <div className="px-3 pt-3 pb-2 border-b border-border/20 space-y-2">
      {/* Top row: count + actions */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-foreground">
          {totalCount} sessions
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

      {/* Search row */}
      <div className="relative">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50 pointer-events-none" />
        <input
          type="text"
          value={searchQuery}
          onChange={e => onSearchChange(e.target.value)}
          placeholder="Search sessions…"
          className="w-full h-7 pl-7 pr-2.5 text-[11px] bg-secondary/40 border border-border/30 rounded-md text-foreground placeholder:text-muted-foreground/40 outline-none focus:border-accent/40 focus:bg-secondary/60 transition-colors"
        />
      </div>
    </div>
  )
}
