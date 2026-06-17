import { memo } from 'react'
import { Chip, ProgressBar, Card } from '@heroui/react'
import { Pause, Play, XCircle, Zap } from 'lucide-react'
import { useLocale } from '../../../hooks/useLocale'
import type { AgentRun, AgentRunStep, AgentRuntimeMessage, AgentSession, ToolCallRecord } from '../../../lib/api/agentRuntime'
import type { CompactionEvent } from '../../state/agentRuntimeStore'
import { getSessionCategory } from './sessionGrouping'
import { resolveSynaxAgentLabel, resolveSynaxRouteReason, isSynaxSession } from './synaxDisplay'
import { SessionStaticTimeline } from './SessionStaticTimeline'

interface Props {
  session: AgentSession | undefined
  runs?: AgentRun[]
  steps: AgentRunStep[]
  toolCalls: ToolCallRecord[]
  messages: AgentRuntimeMessage[]
  childSessions?: AgentSession[]
  compactions?: CompactionEvent[]
  onPause?: (sessionId: string) => void
  onResume?: (sessionId: string) => void
  onCancel?: (sessionId: string) => void
  onExpandChild?: (sessionId: string) => void
  excludeStepId?: string | null
  liveTurn?: React.ReactNode
}

const STATUS_MAP: Record<string, { text: string; color: 'accent' | 'success' | 'danger' | 'warning' | 'default' }> = {
  running: { text: 'running', color: 'accent' },
  completed: { text: 'completed', color: 'success' },
  failed: { text: 'failed', color: 'danger' },
  interrupted: { text: 'warning', color: 'warning' },
  paused: { text: 'paused', color: 'default' },
  waiting_permission: { text: 'waiting', color: 'warning' },
  blocked: { text: 'blocked', color: 'warning' },
  cancelled: { text: 'cancelled', color: 'default' },
  queued: { text: 'draft', color: 'default' },
}

export const AgentConversationView = memo(function AgentConversationView({
  session,
  runs = [],
  steps,
  toolCalls,
  messages,
  childSessions,
  compactions,
  onPause,
  onResume,
  onCancel,
  onExpandChild,
  excludeStepId = null,
  liveTurn,
}: Props) {
  const { t } = useLocale()

  const isRunning = session?.status === 'running' && Boolean(session.activeRunId)
  const isResumable = session?.status === 'interrupted'
    || session?.status === 'paused'
    || session?.status === 'failed'
    || session?.status === 'blocked'
  const cat = session ? getSessionCategory(session.profileId) : null
  const agentLabel = session ? resolveSynaxAgentLabel(session) : 'agent'
  const routeReason = session ? resolveSynaxRouteReason(session) : null
  const statusInfo = session ? STATUS_MAP[session.status] : null

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-2 border-b border-border/40 pb-3">
        <Chip size="sm" variant="soft" color="default" className="text-[11px]">
          {agentLabel}
        </Chip>
        {session && routeReason && isSynaxSession(session) ? (
          <span className="max-w-[240px] truncate text-[10px] text-muted-foreground" title={routeReason}>
            {routeReason}
          </span>
        ) : null}
        {cat?.isBuiltin ? (
          <Chip size="sm" variant="secondary" color="accent" className="text-[10px]">
            {t('sessionBuiltin')}
          </Chip>
        ) : null}
        {statusInfo ? (
          <Chip size="sm" variant="soft" color={statusInfo.color} className="text-[11px]">
            {statusInfo.text}
          </Chip>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          {isRunning && onPause && session ? (
            <button
              type="button"
              onClick={() => onPause(session.id)}
              className="wh-pill-btn wh-pill-btn--neutral"
            >
              <Pause size={10} /> {t('sessionPause')}
            </button>
          ) : null}
          {isResumable && onResume && session ? (
            <button
              type="button"
              onClick={() => onResume(session.id)}
              className="wh-pill-btn wh-pill-btn--soft"
            >
              <Play size={10} /> {t('sessionResume')}
            </button>
          ) : null}
          {isRunning && onCancel && session ? (
            <button
              type="button"
              onClick={() => onCancel(session.id)}
              className="wh-pill-btn wh-pill-btn--danger-soft"
            >
              <XCircle size={10} /> {t('sessionCancel')}
            </button>
          ) : null}
        </div>
      </div>

      {isRunning ? (
        <ProgressBar size="sm" color="accent" className="w-full" isIndeterminate>
          <ProgressBar.Track>
            <ProgressBar.Fill />
          </ProgressBar.Track>
        </ProgressBar>
      ) : null}

      {compactions && compactions.length > 0
        ? compactions.map((c, i) => (
            <div key={`compaction-${i}`} className="flex items-center gap-2 rounded-md border border-warning/20 bg-warning/5 px-3 py-1.5 text-[11px] text-warning">
              <Zap size={12} />
              <span>上下文压缩: {c.originalTokens.toLocaleString()} → {c.compressedTokens.toLocaleString()} tokens ({c.messageCount} 条消息被摘要)</span>
            </div>
          ))
        : null}

      <SessionStaticTimeline
        session={session}
        runs={runs}
        steps={steps}
        messages={messages}
        toolCalls={toolCalls}
        childSessions={childSessions}
        excludeStepId={excludeStepId}
        isRunning={isRunning}
        onExpandChild={onExpandChild}
      />
      {liveTurn}

      {session?.status === 'failed' ? (
        <Card className="border-destructive/15 bg-destructive/[0.03] shadow-none">
          <div className="px-3.5 py-2.5">
            <Chip size="sm" color="danger" variant="soft" className="mb-1 text-[10px]">Failed</Chip>
            <div className="text-[13px] leading-relaxed text-muted-foreground">
              {session.blockedReason ?? 'Agent execution failed'}
            </div>
          </div>
        </Card>
      ) : null}

      {isResumable ? (
        <Card className="border-sky-500/15 bg-sky-500/[0.03] shadow-none">
          <div className="px-3.5 py-2.5">
            <Chip size="sm" color="default" variant="soft" className="mb-1 text-[10px]">
              {session?.status === 'paused' ? 'Paused' : 'Interrupted'}
            </Chip>
            <div className="text-[13px] leading-relaxed text-muted-foreground">
              {session?.blockedReason ?? t('sessionPausedHint')}
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  )
})
