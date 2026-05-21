// ---------------------------------------------------------------------------
// web/.../context/ContextBreadcrumbs.tsx
//
// 当前会话的紧凑状态指示条：显示 sessionId 末尾、entry/token 数与同步状态。
// 放置在 CoordToolbar 附近，让用户一眼看到"正在记录上下文"。
// ---------------------------------------------------------------------------

import { Activity, AlertTriangle, MessageSquare } from 'lucide-react'
import { useContextStore } from '../../../state/contextStore'

export default function ContextBreadcrumbs() {
  const currentSessionId = useContextStore((s) => s.currentSessionId)
  const sessions = useContextStore((s) => s.sessions)
  const syncStatus = useContextStore((s) => s.syncStatus)
  const tokenWarnings = useContextStore((s) => s.tokenWarnings)

  const session = sessions.find((x) => x.id === currentSessionId) || null
  const warning = currentSessionId ? tokenWarnings[currentSessionId] : undefined

  const dotColor =
    syncStatus === 'connected'
      ? 'bg-success'
      : syncStatus === 'connecting'
      ? 'bg-warning animate-pulse'
      : syncStatus === 'error'
      ? 'bg-destructive'
      : 'bg-muted-foreground/40'

  if (!session) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border/40 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotColor}`} />
        <span>no active session</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 rounded-md border border-border/40 bg-background/70 px-2 py-1 font-mono text-[10px] text-muted-foreground">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotColor}`} />
      <span className="max-w-[120px] truncate" title={session.title ?? session.id}>
        {session.title ?? session.id.slice(-8)}
      </span>
      <span className="flex items-center gap-1">
        <MessageSquare size={10} />
        {session.entryCount}
      </span>
      <span className="flex items-center gap-1">
        <Activity size={10} />
        {session.tokenCount}
      </span>
      {warning && (
        <span
          className="flex items-center gap-1 text-warning"
          title={`tokens near threshold (${warning.tokenCount}/${warning.threshold})`}
        >
          <AlertTriangle size={10} />
          near limit
        </span>
      )}
    </div>
  )
}
