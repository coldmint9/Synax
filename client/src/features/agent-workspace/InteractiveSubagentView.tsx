import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import type { AgentSession } from "../../adapters/transport/agentRuntime";
import { AgentConversationView } from "./AgentConversationView";
import { InteractionSessionProvider } from "./AgentInteractionPanel";
import { RetryIndicator } from "./RetryIndicator";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { isStreamingLiveEmpty } from "./streamingLiveBlocks";
import { getConversationController } from "./state/conversationController";
import { useConversationState } from "./state/useConversationState";
import { useTranscriptScroll } from "./useTranscriptScroll";
import { useLocale } from "../../shared/hooks/useLocale";
import { usePendingSubmissionStore } from "./state/pendingSubmissionStore";
import { setSessionHistoryReading } from "./state/sessionTailWindow";
import { withoutInheritedSnapshot } from "./sideChatTranscript";

function ConversationActivity({ sessionId }: { sessionId: string }) {
  const { retry, thinking } = useConversationState(sessionId, useShallow(state => ({
    retry: state.streamingRetry,
    thinking: !state.loading && (state.session?.status === "running" || state.session?.status === "queued") && isStreamingLiveEmpty(state.streamingLive),
  })));
  return retry ? <RetryIndicator retry={retry} /> : thinking ? <ThinkingIndicator /> : null;
}

/** A live child transcript scoped by sessionId, independent of the selected parent. */
export const InteractiveSubagentView = memo(function InteractiveSubagentView({
  sessionId,
  onSessionChange,
  header,
  inheritedThrough,
}: {
  sessionId: string;
  onSessionChange?: (session: AgentSession) => void;
  header?: ReactNode;
  /** Set for side chats: records at or before this instant are snapshot context only. */
  inheritedThrough?: string | null;
}) {
  const { locale } = useLocale();
  const scrollRef = useRef<HTMLDivElement>(null);
  const controller = getConversationController(sessionId);
  const state = useConversationState(sessionId, useShallow(state => ({
    session: state.session, history: state.history, error: state.error, loading: state.loading,
    loadingEarlier: state.loadingEarlier, streamingStepId: state.streamingStepId,
  })));
  const transcript = useMemo(
    () => withoutInheritedSnapshot(state.history, inheritedThrough),
    [state.history, inheritedThrough],
  );
  const readingChanged = useCallback((reading: boolean) => setSessionHistoryReading(sessionId, reading), [sessionId]);
  const { scrollToBottom } = useTranscriptScroll(scrollRef, sessionId, readingChanged, Boolean(state.session));
  const pendingId = usePendingSubmissionStore(store => store.items[sessionId]?.requestId);
  useLayoutEffect(() => { if (pendingId) scrollToBottom(true); }, [pendingId, scrollToBottom]);
  const callback = useRef(onSessionChange);
  callback.current = onSessionChange;
  const summaryKey = state.session ? JSON.stringify([
    state.session.id, state.session.status, state.session.activeRunId,
    state.session.pendingResumeToken, state.session.blockedReason,
    state.session.title, state.session.resultSummary,
  ]) : null;
  const sessionRef = useRef(state.session);
  sessionRef.current = state.session;
  useEffect(() => { if (sessionRef.current) callback.current?.(sessionRef.current); }, [summaryKey]);

  // History pages arrive without a prompt: reaching for the top is the intent.
  const olderCursor = state.history.historyWindow?.olderCursor;
  const requestedCursor = useRef<string | null>(null);
  useEffect(() => {
    if (state.error) requestedCursor.current = null;
  }, [state.error]);
  const requestEarlier = (element: HTMLElement) => {
    if (!olderCursor || element.scrollTop > 96) return;
    if (requestedCursor.current === olderCursor) return;
    requestedCursor.current = olderCursor;
    void loadEarlier();
  };

  const loadEarlier = async () => {
    const element = scrollRef.current;
    const height = element?.scrollHeight ?? 0;
    const top = element?.scrollTop ?? 0;
    await controller.loadEarlier();
    requestAnimationFrame(() => {
      if (element && element === scrollRef.current) element.scrollTop = top + element.scrollHeight - height;
    });
  };
  if (state.error && !state.session) return <div role="alert" className="flex h-full items-center justify-center p-4 text-xs text-destructive">{state.error}<button type="button" onClick={() => void controller.refresh()}>{locale === "zh" ? "重试" : "Retry"}</button></div>;
  if (!state.session) return <div className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground">{locale === "zh" ? "加载子会话…" : "Loading conversation…"}</div>;

  return (
    <div ref={scrollRef} className="session-workspace-scroll min-h-0 flex-1 overflow-auto"
      onScroll={(event) => requestEarlier(event.currentTarget)}>
      <div className="session-workspace-scroll-content">
        {header}
        {state.error && <div role="alert" className="flex items-center justify-center gap-2 p-2 text-xs text-destructive">{state.error}<button type="button" onClick={() => void controller.refresh()}>{locale === "zh" ? "重试" : "Retry"}</button></div>}
        <InteractionSessionProvider controller={controller}><AgentConversationView
          session={state.session}
          runs={transcript.runs}
          steps={transcript.steps}
          toolCalls={transcript.toolCalls}
          messages={transcript.messages}
          scopedConversation={controller}
          excludeStepId={state.streamingStepId}
          unifiedLive
          scrollRootRef={scrollRef}
          liveTurn={<ConversationActivity sessionId={sessionId} />}
        /></InteractionSessionProvider>
      </div>
    </div>
  );
});
