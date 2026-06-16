import { ExternalLink, Sparkles } from 'lucide-react'
import { useLocale } from '../../../../hooks/useLocale'
import { PermissionApprovalBar } from '../../sessions/PermissionApprovalBar'
import { ThinkingBlock } from '../../sessions/ThinkingBlock'
import { GoalToolRow } from './GoalToolRow'
import type { GoalToolCall } from './goalSessionStream'
import type { PermissionDecision } from '../../../../lib/api/agentRuntime'

interface Props {
  statusLabel: string
  toolCalls: GoalToolCall[]
  permissions: PermissionDecision[]
  thinking: string
  streamingText: string
  isRunning: boolean
  isWaitingPermission: boolean
  error: string | null
  onOpenSession?: () => void
  onReplyPermission?: (permissionId: string, reply: 'once' | 'always' | 'reject') => void
}

export function GoalDialogPanel({
  statusLabel,
  toolCalls,
  permissions,
  thinking,
  streamingText,
  isRunning,
  isWaitingPermission,
  error,
  onOpenSession,
  onReplyPermission,
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
        <Sparkles size={12} className="text-primary" />
        {statusLabel}
        {(isRunning || isWaitingPermission) && (
          <span className="text-[11px] font-normal text-muted-foreground/60">
            · {isWaitingPermission ? t('goalWaitingApproval') : 'live'}
          </span>
        )}
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
        ) : !thinking.trim() ? (
          <p className="py-1 text-[11px] text-muted-foreground/50">{t('goalWorking')}</p>
        ) : null}

        {streamingText.trim() && (
          <div className="rounded-md border border-border/25 bg-muted/15 px-3 py-2 text-[11px] leading-relaxed text-foreground/80 whitespace-pre-wrap">
            {streamingText}
          </div>
        )}
      </div>

      {onReplyPermission && (
        <div className="goal-dock-dialog-permissions mt-2 overflow-hidden rounded-xl border border-border/35">
          <PermissionApprovalBar
            permissions={permissions}
            onReply={onReplyPermission}
          />
        </div>
      )}
    </div>
  )
}
