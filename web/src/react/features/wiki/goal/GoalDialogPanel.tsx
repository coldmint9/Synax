import { ExternalLink } from 'lucide-react'
import { useLocale } from '../../../../hooks/useLocale'
import { ThinkingBlock } from '../../sessions/ThinkingBlock'
import { AgentWorkingIndicator } from './AgentWorkingIndicator'
import { GoalQuickApproval, listPendingGoalPermissions } from './GoalQuickApproval'
import { GoalToolRow } from './GoalToolRow'
import type { GoalSessionStatus, GoalToolCall } from './goalSessionStream'
import type { PermissionDecision } from '../../../../lib/api/agentRuntime'

interface Props {
  status: GoalSessionStatus
  sessionTitle: string
  toolCalls: GoalToolCall[]
  thinking: string
  streamingText: string
  isRunning: boolean
  error: string | null
  permissions?: PermissionDecision[]
  onReplyPermission?: (permissionId: string, reply: 'once' | 'always' | 'reject') => void
  onOpenSession?: () => void
}

export function GoalDialogPanel({
  status,
  sessionTitle,
  toolCalls,
  thinking,
  streamingText,
  isRunning,
  error,
  permissions = [],
  onReplyPermission,
  onOpenSession,
}: Props) {
  const { t } = useLocale()
  const recent = toolCalls.slice(-16)
  const runningIndex = isRunning && recent.length > 0 ? recent.length - 1 : -1

  return (
    <div className="goal-dock-dialog relative w-full rounded-2xl border border-white/55 bg-white/48 p-3.5 pb-3 shadow-lg backdrop-blur-xl dark:border-border/50 dark:bg-card/90">
      {onOpenSession && (
        <button
          type="button"
          onClick={onOpenSession}
          aria-label={t('goalOpenFullSession')}
          className="absolute top-2.5 right-2.5 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/45 transition-colors hover:bg-muted/40 hover:text-muted-foreground/80"
        >
          <ExternalLink size={13} strokeWidth={2} />
        </button>
      )}

      <div className="mb-2.5 flex items-center gap-1.5 pr-7 text-[13px] font-medium text-foreground">
        <AgentWorkingIndicator status={status} />
        {sessionTitle}
      </div>

      {error && (
        <p className="mb-2 text-[11px] text-destructive/90">{error}</p>
      )}

      <div className="goal-dock-dialog-scroll max-h-[14rem] space-y-2 overflow-y-auto">
        {thinking.trim() && (
          <ThinkingBlock content={thinking} isStreaming={isRunning && !recent.length} />
        )}

        {recent.length > 0 ? (
          <div className="space-y-0.5">
            {recent.map((tc, i) => (
              <GoalToolRow
                key={tc.id}
                toolId={tc.tool}
                summary={tc.outputSummary ?? tc.summary}
                running={i === runningIndex}
              />
            ))}
          </div>
        ) : null}

        {streamingText.trim() && (
          <div className="rounded-md border border-border/25 bg-muted/15 px-3 py-2 text-[11px] leading-relaxed text-foreground/80 whitespace-pre-wrap">
            {streamingText}
          </div>
        )}
      </div>

      {onReplyPermission && listPendingGoalPermissions(permissions).length > 0 && (
        <div className="goal-dock-dialog-permissions mt-2 border-t border-border/25 pt-2">
          <GoalQuickApproval
            permissions={permissions}
            onReply={onReplyPermission}
            variant="strip"
            showIndicator
          />
        </div>
      )}
    </div>
  )
}
