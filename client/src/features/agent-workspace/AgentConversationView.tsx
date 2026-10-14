import { useAgentSessionStore } from "./state/agentSessionStore";
import { SessionHistoryProvider } from "./SessionHistoryContext";
import { TranscriptSessionProvider } from "./SessionTranscriptContext";
import { memo } from "react";
import { Badge, Card } from "@/shared/ui/ui/Display";
import { XCircle, Zap } from "lucide-react";
import { useLocale } from "../../shared/hooks/useLocale";
import type {
  AgentRun,
  AgentRunStep,
  AgentRuntimeMessage,
  AgentSession,
  ToolCallRecord,
} from "../../adapters/transport/agentRuntime";
import type { CompactionEvent } from "../../shared/state/agentRuntimeStore";
import { getSessionCategory } from "./sessionGrouping";
import { resolveSynaxRouteReason, isSynaxSession } from "./synaxDisplay";
import { SessionStaticTimeline } from "./SessionStaticTimeline";
import { MarkdownRenderer } from "../../shared/ui/markdown/MarkdownRenderer";

interface Props {
  session: AgentSession | undefined;
  runs?: AgentRun[];
  steps: AgentRunStep[];
  toolCalls: ToolCallRecord[];
  messages: AgentRuntimeMessage[];
  childSessions?: AgentSession[];
  compactions?: CompactionEvent[];
  onCancel?: (sessionId: string) => void;
  onExpandChild?: (sessionId: string) => void;
  excludeStepId?: string | null;
  unifiedLive?: boolean;
  submitting?: boolean;
  liveTurn?: React.ReactNode;
  taskDescription?: string;
  /** Scroll container, forwarded so transcript entries can lazy-mount by viewport. */
  scrollRootRef?: React.RefObject<HTMLElement | null>;
}

export const AgentConversationView = memo(function AgentConversationView({
  session,
  runs = [],
  steps,
  toolCalls,
  messages,
  childSessions,
  compactions,
  onCancel,
  onExpandChild,
  excludeStepId = null,
  liveTurn,
  taskDescription,
  unifiedLive = false,
  submitting = false,
  scrollRootRef,
}: Props) {
  const { t, locale } = useLocale();
  const historyWindow = useAgentSessionStore(s => session ? s.sessionDetailCache[session.id]?.historyWindow : undefined);
  const historicalPage = historyWindow?.latest === false;
  const failureInTimeline = runs.some(
    run => run.sessionId === session?.id && run.status === "failed",
  );

  const isRunning =
    session?.status === "running" && Boolean(session.activeRunId);
  const isResumable =
    !submitting && !historicalPage &&
    !(session?.status === "failed" && failureInTimeline) &&
    (session?.status === "interrupted" || session?.status === "failed");
  const cat = session ? getSessionCategory(session.profileId) : null;
  const routeReason = session ? resolveSynaxRouteReason(session) : null;
  const showHeader = Boolean(isRunning && onCancel);

  return (
    <TranscriptSessionProvider sessionId={session?.id}>
      <SessionHistoryProvider session={session} messages={messages}>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-[1.2rem] py-4">
        {taskDescription?.trim() && (
          <section aria-label={locale === "zh" ? "任务说明" : "Task instructions"}
            className="subagent-task-instructions">
            <div className="subagent-task-instructions-label">
              {locale === "zh" ? "任务说明" : "Task instructions"}
            </div>
            <div className="min-w-0 break-words text-[13px] leading-relaxed">
              <MarkdownRenderer content={taskDescription} />
            </div>
          </section>
        )}
        {showHeader ? (
          <div className="flex items-center gap-2 border-b border-border/40 pb-3">
            {session && routeReason && isSynaxSession(session) ? (
              <span
                className="max-w-[240px] truncate text-[10px] text-muted-foreground"
                title={routeReason}
              >
                {routeReason}
              </span>
            ) : null}
            {cat?.isBuiltin ? (
              <Badge
                size="sm"
                variant="secondary"
                tone="accent"
                className="text-[10px]"
              >
                {t("sessionBuiltin")}
              </Badge>
            ) : null}
            <div className="ml-auto flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                {isRunning && onCancel && session ? (
                  <button
                    type="button"
                    onClick={() => onCancel(session.id)}
                    className="wh-pill-btn wh-pill-btn--danger-soft"
                  >
                    <XCircle size={10} /> {t("sessionCancel")}
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {compactions && compactions.length > 0
          ? compactions.map((c, i) => (
              <div
                key={`compaction-${i}`}
                className="flex items-center gap-2 rounded-md border border-warning/20 bg-warning/5 px-3 py-1.5 text-[11px] text-warning"
              >
                <Zap size={12} />
                <span>
                  上下文压缩: {c.originalTokens.toLocaleString()} →{" "}
                  {c.compressedTokens.toLocaleString()} tokens ({c.messageCount}{" "}
                  条消息被摘要)
                </span>
              </div>
            ))
          : null}

        <SessionStaticTimeline
          unifiedLive={unifiedLive}
          session={session}
          runs={runs}
          steps={steps}
          messages={messages}
          toolCalls={toolCalls}
          childSessions={childSessions}
          excludeStepId={excludeStepId}
          isRunning={isRunning}
          onExpandChild={onExpandChild}
          scrollRootRef={scrollRootRef}
        />
        {!historicalPage && liveTurn}

        {isResumable ? (
          <Card
            className={
              session?.status === "failed"
                ? "border-destructive/15 bg-destructive/[0.03] shadow-none"
                : "border-run/15 bg-run/[0.03] shadow-none"
            }
          >
            <div className="px-3.5 py-2.5">
              <Badge
                size="sm"
                tone={session?.status === "failed" ? "danger" : "default"}
                variant="soft"
                className="mb-1 text-[10px]"
              >
                {session?.status === "failed"
                  ? t("activityStatusFailed")
                  : t("activityStatusInterrupted")}
              </Badge>
              <div className="text-[13px] leading-relaxed text-muted-foreground">
                {session?.blockedReason ?? t("sessionResumeHint")}
              </div>
            </div>
          </Card>
        ) : null}
        </div>
      </SessionHistoryProvider>
    </TranscriptSessionProvider>
  );
});
