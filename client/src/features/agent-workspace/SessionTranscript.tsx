import { setSessionHistoryReading } from "./state/sessionTailWindow";
import { useLocale } from "../../shared/hooks/useLocale";
import { useTranscriptScroll } from "./useTranscriptScroll";
import { useTranscriptReveal } from "./useTranscriptReveal";
import { useSwitchTransition } from "./useSwitchTransition";
import { useTranscriptRenderPending } from "./useTranscriptRenderPending";
import { useOlderTranscriptHistory } from "./useOlderTranscriptHistory";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  projectPendingSubmission,
  usePendingSubmissionStore,
} from "./state/pendingSubmissionStore";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { RetryIndicator } from "./RetryIndicator";
import { hasDisplayableReasoning } from "./activityText";
import { hasStreamingText } from "./streamingLiveBlocks";
import { useShallow } from "zustand/react/shallow";
import { useAgentSessionStore } from "./state/agentSessionStore";
import { AgentConversationView } from "./AgentConversationView";
import { sessionCompaction } from "./sessionCompaction";
import { SessionNavigationPanel } from "./SessionNavigationPanel";
import { ScrollToBottomButton } from "./ScrollToBottomButton";
import { SessionTranscriptTransition } from "./SessionTranscriptTransition";
import { SelectionCopyPill } from "./SelectionCopyPill";
import { useSessionWorkspaceEnvironment } from "./SessionEnvironmentContext";
import {
  isSubagentDelegationCall,
  readSubagentSessionId,
} from "./subagentCallMatch";
import { getSubagentName, getSubagentNameFromId } from "./SubagentIdentity";
import { openWorkspaceSubagent } from "./state/sessionWorkspaceStore";
import type { AgentRunStatus } from "../../adapters/transport/agentRuntime";

const RUN_TERMINAL_STATUSES: readonly AgentRunStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "blocked",
];

function useSessionTranscriptStatic() {
  return useAgentSessionStore(
    useShallow((s) => {
      const id = s.selectedSessionId;
      return {
        sessionId: id,
        loading: s.detailLoading,
        refreshing: s.detailRefreshing,
        error: s.detailError,
        session: id ? s.sessions.find((ss) => ss.id === id) : undefined,
        runs: s.runs,
        steps: s.steps,
        toolCalls: s.toolCalls,
        messages: s.messages,
        childSessions: id ? s.childSessions[id] : undefined,
        streamingStepId: s.streamingStepId,
        streamingRetry: s.streamingRetry,
        streamingLive: s.streamingLive,
        streamingCompletedSteps: s.streamingCompletedSteps,
        navigationReady: !id || !s.sessionDetailCache[id]?.historyWindow?.hasEarlier ||
          Boolean(s.sessionDetailCache[id]?.timelineIndexLoaded || s.sessionDetailCache[id]?.timelineIndexError),
        historyEpoch: id ? s.sessionDetailCache[id]?.historyWindow?.epoch : undefined,
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
  const transcriptViewportRef = useRef<HTMLDivElement>(null);
  const transcriptContentRef = useRef<HTMLDivElement>(null);

  const {
    session,
    sessionId,
    loading,
    refreshing,
    error,
    runs,
    steps,
    toolCalls,
    messages,
    childSessions,
    streamingStepId,
    streamingRetry,
    streamingLive,
    streamingCompletedSteps,
    navigationReady,
    historyEpoch,
  } = useSessionTranscriptStatic();
  const { environment } = useSessionWorkspaceEnvironment(sessionId);
  const compactionNotice = useAgentSessionStore(
    (s) => s.contextCompactionNotice,
  );
  const compacting =
    sessionCompaction(session)?.status === "running" ||
    compactionNotice?.status === "running";
  const hasCompactionRow = messages.some(
    (message) =>
      message.metadata?.source === "context_compaction" &&
      (message.metadata.contextCompaction as { status?: string } | undefined)
        ?.status === "running",
  );
  const compactionId = sessionCompaction(session)?.id;
  const pending = usePendingSubmissionStore((state) =>
    sessionId ? state.items[sessionId] : undefined,
  );
  const projected = useMemo(
    () => projectPendingSubmission(pending, runs, messages),
    [pending, runs, messages],
  );
  const responseRunId =
    projected.run?.id ?? (pending ? null : session?.activeRunId);
  const responseRun =
    projected.run ?? runs.find((run) => run.id === responseRunId);
  const hasAssistantText = useMemo(() => {
    const responseStepIds = new Set(
      steps
        .filter((step) => step.runId === responseRunId)
        .map((step) => step.id),
    );
    const persistedResponse = Boolean(
      responseRunId &&
      messages.some(
        (message) =>
          message.role === "assistant" &&
          Boolean(message.content.trim()) &&
          (message.runId === responseRunId ||
            (message.stepId !== null && responseStepIds.has(message.stepId)) ||
            (pending && message.metadata.requestId === pending.requestId)),
      ),
    );
    const completedResponse = streamingCompletedSteps.some((step) =>
      step.blocks.some(
        (block) => block.type === "text" && Boolean(block.content.trim()),
      ),
    );
    return (
      persistedResponse || hasStreamingText(streamingLive) || completedResponse
    );
  }, [
    messages,
    pending?.requestId,
    responseRunId,
    steps,
    streamingCompletedSteps,
    streamingLive,
  ]);
  const hasAssistantThinking = useMemo(() => {
    const responseStepIds = new Set(
      steps
        .filter((step) => step.runId === responseRunId)
        .map((step) => step.id),
    );
    const persistedThinking = messages.some((message) => {
      const isThinking =
        message.metadata?.type === "thinking" ||
        message.metadata?.kind === "thought";
      const thought = isThinking ? message.content : message.metadata?.thought;
      return (
        typeof thought === "string" &&
        hasDisplayableReasoning(thought) &&
        (message.runId === responseRunId ||
          (message.stepId !== null && responseStepIds.has(message.stepId)) ||
          (pending && message.metadata.requestId === pending.requestId))
      );
    });
    return (
      persistedThinking ||
      streamingCompletedSteps.some((step) =>
        step.blocks.some(
          (block) =>
            block.type === "thinking" && hasDisplayableReasoning(block.content),
        ),
      ) ||
      streamingLive.blocks.some(
        (block) =>
          block.type === "thinking" && hasDisplayableReasoning(block.content),
      ) ||
      hasDisplayableReasoning(streamingLive.pendingThinking)
    );
  }, [
    messages,
    pending?.requestId,
    responseRunId,
    steps,
    streamingCompletedSteps,
    streamingLive,
  ]);
  // Tool calls already render their own live row. Keeping the generic
  // thinking placeholder mounted beneath that row makes a healthy tool-only
  // turn look stalled, and after twenty seconds it incorrectly shows the
  // network/provider warning from ThinkingIndicator.
  const hasLiveToolActivity =
    streamingLive.pendingToolCalls.length > 0 ||
    streamingLive.blocks.some(
      (block) => block.type === "tool_call" || block.type === "tool_call_group",
    );
  const runFinished = Boolean(
    (responseRun && RUN_TERMINAL_STATUSES.includes(responseRun.status)) ||
      (pending &&
        session &&
        !session.activeRunId &&
        RUN_TERMINAL_STATUSES.includes(session.status as AgentRunStatus)),
  );
  // A running session row is not enough to show thinking: during a switch its
  // detail snapshot may still be loading.
  // A refresh keeps the cached transcript mounted, but the placeholder should
  // wait until the refreshed snapshot is ready to avoid a false new turn.
  const detailReady = !loading && !refreshing;
  const retry =
    active &&
    streamingStepId &&
    !runFinished &&
    (session?.status === "running" || session?.status === "queued") &&
    streamingRetry?.phase !== "recovered"
      ? streamingRetry
      : null;
  const showThinking =
    (Boolean(pending) || detailReady) &&
    session?.status !== "waiting_input" &&
    responseRun?.status !== "waiting_input" &&
    !hasAssistantText &&
    !hasAssistantThinking &&
    !hasLiveToolActivity &&
    !runFinished &&
    (Boolean(pending) ||
      session?.status === "queued" ||
      session?.status === "running");
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
      (hasAssistantText || runFinished)
    )
      usePendingSubmissionStore.getState().clear(sessionId, pending.requestId);
  }, [sessionId, pending, projected.confirmed, hasAssistantText, runFinished]);
  // Live content bridges the gap until a complete persisted transcript arrives.
  // A step/status response alone does not mean its messages are ready yet.
  const showLiveBlock = Boolean(streamingStepId) && (!loading || Boolean(pending));
  // Live events can populate messages before the initial history request ends.
  // Keep that partial snapshot behind the loader unless this is a local send.
  const waitingForHistory = loading && !pending;
  const readingChanged = useCallback((reading: boolean) => {
    if (sessionId) setSessionHistoryReading(sessionId, reading);
    onReadingHistoryChange?.(reading);
  }, [sessionId, onReadingHistoryChange]);
  const { scrollToBottom } = useTranscriptScroll(
    scrollRef,
    sessionId ?? undefined,
    readingChanged,
    active && !waitingForHistory,
  );
  const olderHistory = useOlderTranscriptHistory(
    scrollRef, sessionId, active && detailReady && !waitingForHistory,
  );
  useEffect(() => {
    if (active && detailReady && sessionId && !navigationReady)
      void useAgentSessionStore.getState().loadTimelineIndex();
  }, [active, detailReady, sessionId, historyEpoch, navigationReady]);
  // A complete cached page is already readable. Refreshes, older-page prefetch
  // and navigation indexing run independently of the transcript's first paint.
  const revealed = useTranscriptReveal(
    scrollRef, sessionId,
    !waitingForHistory, active,
  );
  // A cached switch paints the next transcript in the same commit, but its
  // rows mount lazily. Hold the blur until the history is settled and every
  // rendered entry — the tool-call records included — has a real body.
  const renderPending = useTranscriptRenderPending(scrollRef, sessionId, active);
  const historySettled = !loading && !refreshing;
  const switching = useSwitchTransition(
    sessionId,
    active,
    !renderPending && historySettled,
  );
  const coldLoading = !revealed && !error;
  const switchingVisible = switching && !coldLoading;
  const preparing = coldLoading || switching;
  // A delegation row owns a card, so its child is resolved from the call itself
  // instead of waiting for the workspace card to refresh. A blocking delegate
  // completes no parent step while the child runs, which leaves the environment
  // projection empty for that whole stretch.
  const delegatedChildIds = useMemo(() => {
    const ids = new Set<string>();
    for (const toolCall of toolCalls) {
      if (!isSubagentDelegationCall(toolCall)) continue;
      const id =
        readSubagentSessionId(toolCall.outputRef) ??
        // A failed lifecycle call may contain a mistyped/invented child id.
        // Its input is not evidence that a child exists; a returned id still is.
        (toolCall.status === "failed" ? null : readSubagentSessionId(toolCall.inputRef));
      if (id) ids.add(id);
    }
    return [...ids];
  }, [toolCalls]);
  // A delegate that is still running reports no child id at all: the live
  // buffers are the only place that says a child exists.
  const liveDelegation =
    streamingLive.pendingToolCalls.some(isSubagentDelegationCall) ||
    streamingLive.blocks.some((block) =>
      block.type === "tool_call"
        ? isSubagentDelegationCall(block.call)
        : block.type === "tool_call_group"
          ? block.calls.some(isSubagentDelegationCall)
          : false,
    );
  const hydratedChildKey = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    const known = new Set((childSessions ?? []).map((child) => child.id));
    const missing = [
      ...new Set([
        ...(environment?.subagents ?? []).map((child) => child.id),
        ...delegatedChildIds,
      ]),
    ].filter((id) => !known.has(id));
    // Nothing is known yet, so the only way to find a just-started child is to
    // list this parent's children. Once per live step is enough.
    const listing = missing.length === 0 && known.size === 0 && liveDelegation;
    if (!missing.length && !listing) return;
    const key = [
      sessionId,
      streamingStepId ?? "history",
      listing ? "list" : "ids",
      missing.join(","),
    ].join("|");
    if (hydratedChildKey.current === key) return;
    hydratedChildKey.current = key;
    void useAgentSessionStore
      .getState()
      .fetchChildSessions(sessionId, missing.length ? missing : undefined);
  }, [
    sessionId,
    environment?.subagents,
    childSessions,
    delegatedChildIds,
    liveDelegation,
    streamingStepId,
  ]);
  // "详情" opens the child conversation next to the parent, the same target the
  // subagent island uses.
  const openChildSession = useCallback(
    (childId: string) => {
      if (!sessionId) return;
      const child = childSessions?.find((item) => item.id === childId);
      openWorkspaceSubagent(
        sessionId,
        childId,
        child ? getSubagentName(child) : getSubagentNameFromId(childId),
      );
    },
    [sessionId, childSessions],
  );
  useLayoutEffect(() => {
    if (compacting) scrollToBottom(true);
  }, [compacting, compactionId]);

  // Trigger 1: a new submission lands — jump to the bottom and re-pin.
  useLayoutEffect(() => {
    if (pending && active) scrollToBottom(true);
    // Only a new requestId may trigger; pending mutation (run accept) must not.
  }, [pending?.requestId, active, scrollToBottom]);

  // Trigger 2: the AI's first response for this submission starts streaming.
  const firstResponseStepRef = useRef<{
    sessionId: string | null;
    stepId: string | null;
    detailReady: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    const prev = firstResponseStepRef.current;
    firstResponseStepRef.current = { sessionId, stepId: streamingStepId, detailReady };
    if (
      active &&
      ((!preparing && detailReady && prev?.detailReady) || pending) &&
      prev?.sessionId === sessionId &&
      streamingStepId &&
      !prev.stepId
    )
      scrollToBottom(true);
  }, [sessionId, streamingStepId, active, preparing, pending, detailReady, scrollToBottom]);

  // Trigger 3: the run reaches a terminal state (task finished).
  const runStatusRef = useRef<{
    sessionId: string | null;
    status: AgentRunStatus | undefined;
    detailReady: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    const status = latestRunStatus;
    const prev = runStatusRef.current;
    runStatusRef.current = { sessionId, status, detailReady };
    if (
      active &&
      ((!preparing && detailReady && prev?.detailReady) || pending) &&
      prev?.sessionId === sessionId &&
      status &&
      RUN_TERMINAL_STATUSES.includes(status) &&
      prev.status &&
      !RUN_TERMINAL_STATUSES.includes(prev.status)
    )
      scrollToBottom(true);
  }, [sessionId, latestRunStatus, active, preparing, pending, detailReady, scrollToBottom]);

  return (
    <div className="session-chat flex min-h-0 flex-1 flex-col">
      <div
        ref={transcriptViewportRef}
        className="session-transcript-viewport relative min-h-0 flex-1"
      >
        <SessionTranscriptTransition
          key={sessionId}
          preparing={coldLoading}
        />
        <div
          ref={scrollRef}
          data-preparing={preparing ? "true" : "false"}
          data-enter={switchingVisible ? "switch" : undefined}
          inert={preparing}
          aria-hidden={preparing}
          tabIndex={0}
          aria-label={locale === "zh" ? "对话记录" : "Conversation history"}
          className="session-chat-scroll scrollbar-none h-full overflow-y-auto"
          aria-busy={preparing || loading || refreshing || olderHistory.loading || olderHistory.settling}
        >
          <div className="session-transcript-body">
            {error && projected.messages.length > 0 && (
              <div data-error-toast="off" role="alert" className="px-4 py-2 text-[13px] text-muted-foreground">
                {locale === "zh" ? "历史更新失败，已保留加载的内容。" : "History could not be updated. Loaded content is preserved."}{" "}
                <button type="button" className="underline" onClick={() => void useAgentSessionStore.getState().refreshDetail({ forceFresh: true })}>
                  {locale === "zh" ? "重试" : "Retry"}
                </button>
              </div>
            )}
            {waitingForHistory ? null : error && projected.messages.length === 0 && !showLiveBlock ? (
              <div
                data-error-toast="off"
                role="alert"
                className="p-6 text-center text-[13px] text-muted-foreground"
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
                    void useAgentSessionStore.getState().refreshDetail({ forceFresh: true })
                  }
                >
                  {locale === "zh" ? "重试" : "Retry"}
                </button>
              </div>
            ) : (
              <div
                key={sessionId ?? "empty-session"}
                ref={transcriptContentRef}
                className="session-transcript-content"
              >
                <AgentConversationView
                  session={session}
                  runs={runs}
                  steps={steps}
                  toolCalls={toolCalls}
                  messages={projected.messages}
                  childSessions={childSessions}
                  onExpandChild={openChildSession}
                  excludeStepId={showLiveBlock ? streamingStepId : null}
                  unifiedLive={active && (!loading || Boolean(pending))}
                  submitting={Boolean(pending)}
                  scrollRootRef={scrollRef}
                  liveTurn={
                    retry ? (
                      <RetryIndicator retry={retry} />
                    ) : compacting && !hasCompactionRow ? (
                      <ThinkingIndicator
                        label={
                          locale === "zh"
                            ? "正在压缩上下文"
                            : "Compacting context"
                        }
                      />
                    ) : compactionNotice?.status === "failed" ? (
                      <p data-error-toast="off" role="alert" className="text-[11px] text-danger">
                        {compactionNotice.error}
                      </p>
                    ) : showThinking ? (
                      <ThinkingIndicator />
                    ) : undefined
                  }
                />
              </div>
            )}
          </div>
        </div>
        {active && !preparing && (
          // Fades in above the composer once the reader leaves the live edge,
          // so returning to the newest message never needs a long scroll.
          <ScrollToBottomButton
            scrollRef={scrollRef}
            onScrollToBottom={() => scrollToBottom(true)}
          />
        )}
        {active && !preparing && <SessionNavigationPanel scrollRootRef={scrollRef} />}
        <SelectionCopyPill
          hostRef={transcriptViewportRef}
          scopeRef={transcriptContentRef}
          scrollRef={scrollRef}
        />
      </div>
    </div>
  );
}
