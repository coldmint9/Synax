import { useLocale } from "../../../hooks/useLocale";
import { useTranscriptScroll } from "./useTranscriptScroll";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  projectPendingSubmission,
  usePendingSubmissionStore,
} from "./state/pendingSubmissionStore";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { Skeleton } from "@heroui/react";
import { useShallow } from "zustand/react/shallow";
import { useAgentSessionStore } from "./state/agentSessionStore";
import { AgentConversationView } from "./AgentConversationView";
import { SessionNavigationPanel } from "./SessionNavigationPanel";
import type { AgentRunStatus } from "../../../lib/api/agentRuntime";

const RUN_TERMINAL_STATUSES: readonly AgentRunStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

function useSessionTranscriptStatic() {
  return useAgentSessionStore(
    useShallow((s) => {
      const id = s.selectedSessionId;
      return {
        sessionId: id,
        loading: s.detailLoading,
        error: s.detailError,
        session: id ? s.sessions.find((ss) => ss.id === id) : undefined,
        runs: s.runs,
        steps: s.steps,
        toolCalls: s.toolCalls,
        messages: s.messages,
        childSessions: id ? s.childSessions[id] : undefined,
        streamingStepId: s.streamingStepId,
      };
    }),
  );
}

export function SessionTranscript({
  onReadingHistoryChange,
  active = true,
}: {
  active?: boolean;
  onReadingHistoryChange?: (reading: boolean) => void;
}) {
  const { locale } = useLocale();
  const scrollRef = useRef<HTMLDivElement>(null);

  const {
    session,
    sessionId,
    loading,
    error,
    runs,
    steps,
    toolCalls,
    messages,
    childSessions,
    streamingStepId,
  } = useSessionTranscriptStatic();
  const pending = usePendingSubmissionStore((state) =>
    sessionId ? state.items[sessionId] : undefined,
  );
  const projected = useMemo(
    () => projectPendingSubmission(pending, runs, messages),
    [pending, runs, messages],
  );
  const hasResponse = Boolean(
    projected.run &&
    (steps.some((step) => step.runId === projected.run!.id) ||
      RUN_TERMINAL_STATUSES.includes(projected.run.status)),
  );
  const latestRunStatus = useMemo(() => {
    if (!sessionId) return undefined;
    for (let i = runs.length - 1; i >= 0; i -= 1) {
      if (runs[i].sessionId === sessionId) return runs[i].status;
    }
    return undefined;
  }, [runs, sessionId]);
  useEffect(() => {
    if (
      sessionId &&
      pending &&
      projected.confirmed &&
      (hasResponse || streamingStepId)
    )
      usePendingSubmissionStore.getState().clear(sessionId, pending.requestId);
  }, [sessionId, pending, projected.confirmed, hasResponse, streamingStepId]);
  // Live content bridges the gap until a complete persisted transcript arrives.
  // A step/status response alone does not mean its messages are ready yet.
  const showLiveBlock = Boolean(streamingStepId);
  const { scrollToBottom } = useTranscriptScroll(
    scrollRef,
    sessionId ?? undefined,
    onReadingHistoryChange,
    active && (!loading || showLiveBlock || Boolean(pending)),
  );

  // Trigger 1: a new submission lands — jump to the bottom and re-pin.
  useLayoutEffect(() => {
    if (pending && active) scrollToBottom(true);
    // Only a new requestId may trigger; pending mutation (run accept) must not.
  }, [pending?.requestId, active, scrollToBottom]);

  // Trigger 2: the AI's first response for this submission starts streaming.
  const firstResponseStepRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const prev = firstResponseStepRef.current;
    firstResponseStepRef.current = streamingStepId;
    if (streamingStepId && !prev) scrollToBottom(true);
  }, [streamingStepId, scrollToBottom]);

  // Trigger 3: the run reaches a terminal state (task finished).
  const runStatusRef = useRef<AgentRunStatus | undefined>(undefined);
  useLayoutEffect(() => {
    const status = latestRunStatus;
    const prev = runStatusRef.current;
    runStatusRef.current = status;
    if (
      status &&
      RUN_TERMINAL_STATUSES.includes(status) &&
      prev &&
      !RUN_TERMINAL_STATUSES.includes(prev)
    )
      scrollToBottom(true);
  }, [latestRunStatus, scrollToBottom]);

  return (
    <div className="session-chat flex min-h-0 flex-1 flex-col">
      <div className="session-transcript-viewport relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          tabIndex={0}
          aria-label={locale === "zh" ? "对话记录" : "Conversation history"}
          className="session-chat-scroll h-full overflow-y-auto"
          aria-busy={loading}
        >
          <div className="session-transcript-body">
            {loading && projected.messages.length === 0 && !showLiveBlock ? (
              <div
                role="status"
                className="session-transcript-skeleton mx-auto w-full max-w-3xl space-y-6 px-[1.2rem] py-4"
              >
                <span className="sr-only">
                  {locale === "zh" ? "正在加载对话" : "Loading conversation"}
                </span>
                <Skeleton className="ml-auto h-16 w-2/3 rounded-xl" />
                <Skeleton className="h-4 w-3/4 rounded-lg" />
                <Skeleton className="h-4 w-full rounded-lg" />
                <Skeleton className="h-4 w-1/2 rounded-lg" />
                <Skeleton className="mt-8 h-24 w-3/4 rounded-xl" />
              </div>
            ) : error && projected.messages.length === 0 && !showLiveBlock ? (
              <div
                role="alert"
                className="p-6 text-center text-sm text-muted-foreground"
              >
                <p>
                  {locale === "zh"
                    ? "对话加载失败，请重试"
                    : "Could not load conversation"}
                </p>
                <button
                  type="button"
                  className="mt-3 underline"
                  onClick={() =>
                    void useAgentSessionStore.getState().refreshDetail()
                  }
                >
                  {locale === "zh" ? "重试" : "Retry"}
                </button>
              </div>
            ) : (
              <AgentConversationView
                session={session}
                runs={runs}
                steps={steps}
                toolCalls={toolCalls}
                messages={projected.messages}
                childSessions={childSessions}
                excludeStepId={showLiveBlock ? streamingStepId : null}
                unifiedLive={active}
                submitting={Boolean(pending)}
                scrollRootRef={scrollRef}
                liveTurn={
                  pending && !showLiveBlock && !hasResponse ? (
                    <ThinkingIndicator />
                  ) : undefined
                }
              />
            )}
          </div>
        </div>
        {active && <SessionNavigationPanel scrollRootRef={scrollRef} />}
      </div>
    </div>
  );
}
