import type { LlmRetryState } from "../../adapters/transport/sessionLive";
import { RetryIndicator } from "./RetryIndicator";
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { AgentRunStep } from "../../adapters/transport/agentRuntime";
import { ThinkingIndicator } from "./ThinkingIndicator";
import type { TurnContentBlock } from "./buildInterleavedTurns";
import { TurnContent } from "./TurnBody";
import {
  materializeLiveBlocks,
  type StreamingLiveBuffers,
} from "./streamingLiveBlocks";
import { useShellStore } from "../../shared/state/shellStore";

const CompletedStepView = memo(function CompletedStepView({
  blocks,
  stepId,
}: {
  blocks: readonly TurnContentBlock[];
  stepId: string;
}) {
  const showThinking = useShellStore((state) => state.preferences.sessionShowThinking);
  const visibleBlocks = showThinking ? blocks : blocks.filter((block) => block.type !== "thinking");
  if (visibleBlocks.length === 0) return null;
  return (
    <div className="session-completed-step animate-[fade-up_0.3s_ease-out]">
      <div className="session-turn-content flex min-w-0 flex-1 flex-col gap-1">
        <TurnContent blocks={visibleBlocks} rowKeyPrefix={stepId} stepId={stepId} />
      </div>
    </div>
  );
});

const LiveStepView = memo(function LiveStepView({
  streamingLive,
  retry,
  stepId,
}: {
  retry?: LlmRetryState | null;
  streamingLive: StreamingLiveBuffers;
  stepId: string;
}) {
  const showThinking = useShellStore((state) => state.preferences.sessionShowThinking);
  const blocks = useMemo(
    () => {
      const content = materializeLiveBlocks(streamingLive);
      return showThinking ? content : content.filter((block) => block.type !== "thinking");
    },
    [streamingLive, showThinking],
  );
  const hasContent = blocks.length > 0;

  return (
    <div data-stream-step-id={stepId} className="session-turn-content flex min-w-0 flex-1 flex-col gap-1">
      {hasContent ? (
        <TurnContent blocks={blocks} isStreaming rowKeyPrefix={stepId} stepId={stepId} />
      ) : !retry ? (
        <ThinkingIndicator />
      ) : null}
      {retry && <RetryIndicator retry={retry} />}
    </div>
  );
});

interface Props {
  steps: AgentRunStep[];
  retry?: LlmRetryState | null;
  streamingStepId: string | null;
  streamingLive: StreamingLiveBuffers;
  streamingCompletedSteps: Array<{
    stepId: string;
    stepIndex: number;
    blocks: readonly TurnContentBlock[];
  }>;
  scrollContainerRef?: React.RefObject<HTMLElement | null>;
}

export const SessionLiveTurn = memo(function SessionLiveTurn({
  steps,
  streamingStepId,
  retry,
  streamingLive,
  streamingCompletedSteps,
  scrollContainerRef,
}: Props) {
  const isNearBottom = useRef(true);

  const streamingStep = streamingStepId
    ? steps.find((step) => step.id === streamingStepId)
    : undefined;
  const showLiveBlock =
    Boolean(streamingStepId) &&
    (!streamingStep || streamingStep.status === "running");

  // History owns persisted steps; snapshots bridge the gap until detail refresh.
  // A persisted step may arrive before its final assistant message. The store
  // removes snapshots only after content confirmation, so status alone must
  // not hide a still-visible final reply.
  const pendingCompletedSteps = streamingCompletedSteps;

  useEffect(() => {
    const el = scrollContainerRef?.current;
    if (!el) return;
    const onScroll = () => {
      isNearBottom.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollContainerRef]);

  useLayoutEffect(() => {
    const el = scrollContainerRef?.current;
    if (isNearBottom.current && el) {
      // The transcript owns the scroll policy. This legacy adapter only keeps
      // an already-pinned viewport aligned, without starting a smooth scroll
      // animation for every token burst.
      el.scrollTop = el.scrollHeight;
    }
  }, [scrollContainerRef, streamingLive, streamingCompletedSteps.length]);

  if (!showLiveBlock && pendingCompletedSteps.length === 0) {
    return null;
  }

  return (
    <>
      {pendingCompletedSteps.map((step) => (
        <CompletedStepView
          key={step.stepId}
          blocks={step.blocks}
          stepId={step.stepId}
        />
      ))}
      {showLiveBlock ? (
        <LiveStepView key={streamingStepId} stepId={streamingStepId!} streamingLive={streamingLive} retry={retry} />
      ) : null}
    </>
  );
});
