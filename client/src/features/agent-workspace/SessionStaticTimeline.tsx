import { TimelineVirtualWindow } from "./TimelineVirtualWindow";
import {
  memo,
  useMemo,
  type RefObject,
} from "react";
import { shallow } from "zustand/shallow";
import { Skeleton } from "@/shared/ui/ui/Display";
import { useLocale } from "../../shared/hooks/useLocale";
import type {
  AgentRun,
  AgentRunStep,
  AgentRuntimeMessage,
  AgentSession,
  ToolCallRecord,
} from "../../adapters/transport/agentRuntime";
import {
  buildConversationTimeline,
  type ConversationTimelineEntry,
} from "./buildConversationTimeline";
import { TimelineEntryView } from "./TimelineEntryView";
import {
  TimelineLazyEntry,
  estimateEntryHeight,
} from "./TimelineLazyEntry";
import { groupActivityEntries } from "./groupActivityEntries";
import { useFoldTransition } from "./useFoldTransition";
import {
  EMPTY_STREAMING_BUFFERS,
  materializeLiveBlocks,
} from "./streamingLiveBlocks";
import type { TurnContentBlock } from "./buildInterleavedTurns";
import { withSubagentCards } from "./subagentCallMatch";
import { useAgentSessionStore } from "./state/agentSessionStore";
import { isLiveStepPersisted } from "./state/liveStepRetirement";
import { hasDisplayableReasoning } from "./activityText";
import { useShellStore } from "../../shared/state/shellStore";
import { useAppendedEntryIds } from "./useAppendedEntryIds";
import "./transcriptAppend.css";
import type { ConversationController } from "./state/conversationController";
import { useScopedConversationValue } from "./state/useConversationState";

interface Props {
  unifiedLive?: boolean;
  session?: AgentSession;
  runs: AgentRun[];
  steps: AgentRunStep[];
  messages: AgentRuntimeMessage[];
  toolCalls: ToolCallRecord[];
  childSessions?: AgentSession[];
  excludeStepId?: string | null;
  isRunning?: boolean;
  onExpandChild?: (sessionId: string) => void;
  scrollRootRef?: RefObject<HTMLElement | null>;
  scopedConversation?: ConversationController;
}

type RowsProps = Pick<Props, "onExpandChild" | "scrollRootRef" | "scopedConversation"> & {
  entries: ConversationTimelineEntry[];
  sessionId?: string;
  /** Children of the rendered session, so a delegation row owns its card. */
  childSessions?: AgentSession[];
  streaming?: boolean;
  liveId?: string | null;
  liveSeed?: readonly TurnContentBlock[];
  /** Start of the streaming step, the anchor for calls without a child id. */
  liveStartedAt?: string | null;
  eager?: boolean;
  /** Version of cached height measurements, independent of React row identity. */
  cacheVersion?: string;
  /** Temporary live snapshots share the live height-cache namespace. */
  liveEntryIds?: ReadonlySet<string>;
  /**
   * The live step hides its reasoning, so one trailing placeholder must
   * represent every reasoning record of its newest stream.
   */
  hiddenReasoning?: boolean;
};

type RowProps = Omit<RowsProps, "entries" | "streaming"> & {
  entry: ConversationTimelineEntry;
  isWorking: boolean;
  isStreaming: boolean;
  showsHiddenReasoning: boolean;
  appended: boolean;
  /** Height of the process rows this work log replaced, on the fold itself. */
  foldFrom?: number;
};

const EMPTY_LIVE_SEED: readonly TurnContentBlock[] = [];

function sameTurn(
  a: Extract<ConversationTimelineEntry, { kind: "agent" }>["turn"],
  b: Extract<ConversationTimelineEntry, { kind: "agent" }>["turn"],
): boolean {
  return (
    a.stepId === b.stepId &&
    a.index === b.index &&
    a.status === b.status &&
    a.completedAt === b.completedAt &&
    a.blocks.length === b.blocks.length &&
    a.blocks.every((block, index) => shallow(block, b.blocks[index]))
  );
}

function sameTimelineEntry(
  previous: ConversationTimelineEntry,
  next: ConversationTimelineEntry,
): boolean {
  if (previous === next) return true;
  if (
    previous.kind !== next.kind ||
    previous.id !== next.id ||
    previous.createdAt !== next.createdAt ||
    previous.label !== next.label
  )
    return false;
  switch (previous.kind) {
    case "agent":
      return next.kind === "agent" && sameTurn(previous.turn, next.turn);
    case "user":
      return (
        next.kind === "user" &&
        previous.content === next.content &&
        previous.contentParts === next.contentParts
      );
    case "work_log":
      return (
        next.kind === "work_log" &&
        previous.stats.stepCount === next.stats.stepCount &&
        previous.stats.toolCallCount === next.stats.toolCallCount &&
        previous.stats.thinkingChars === next.stats.thinkingChars &&
        previous.stats.elapsedMs === next.stats.elapsedMs &&
        previous.turns.length === next.turns.length &&
        previous.turns.every((turn, index) => sameTurn(turn, next.turns[index]))
      );
    case "interaction":
      return next.kind === "interaction" && previous.interaction === next.interaction;
    case "compaction":
      return next.kind === "compaction" && previous.state === next.state;
    case "error":
      return next.kind === "error" && previous.message === next.message && previous.model === next.model;
    case "model_switch":
      return next.kind === "model_switch" && previous.fromModel === next.fromModel && previous.toModel === next.toModel;
  }
}

const TimelineRow = memo(
  function TimelineRow({
    entry,
    sessionId,
    onExpandChild,
    scrollRootRef,
    isWorking,
    isStreaming,
    showsHiddenReasoning,
    eager,
    cacheVersion,
    appended,
    foldFrom,
  }: RowProps) {
    const key = `${sessionId ?? "standalone"}:${cacheVersion ?? "initial"}:${entry.kind}-${entry.id}`;
    return (
      <TimelineLazyEntry
        entryId={entry.id}
        cacheKey={key}
        estimate={estimateEntryHeight(entry)}
        measureScope={sessionId ?? "standalone"}
        scrollRootRef={scrollRootRef}
        eager={eager}
        appended={appended}
      >
        <TimelineEntryView
          entry={entry}
          onExpandChild={onExpandChild}
          isWorking={isWorking}
          isStreaming={isStreaming}
          showsHiddenReasoning={showsHiddenReasoning}
          foldFrom={foldFrom}
        />
      </TimelineLazyEntry>
    );
  },
  (previous, next) => {
    if (
      previous.sessionId !== next.sessionId ||
      previous.onExpandChild !== next.onExpandChild ||
      previous.scrollRootRef !== next.scrollRootRef ||
      previous.isWorking !== next.isWorking ||
      previous.isStreaming !== next.isStreaming ||
      previous.showsHiddenReasoning !== next.showsHiddenReasoning ||
      previous.eager !== next.eager ||
      previous.cacheVersion !== next.cacheVersion ||
      previous.foldFrom !== next.foldFrom
    )
      return false;
    return sameTimelineEntry(previous.entry, next.entry);
  },
);

function renderTimelineRows({
  entries,
  sessionId,
  streaming,
  liveId,
  onExpandChild,
  scrollRootRef,
  eager,
  cacheVersion,
  liveEntryIds,
  appendedIds,
  foldTransitions,
  hiddenReasoning = false,
  visibleEntries = entries,
  start = 0,
}: RowsProps & {
  appendedIds: ReadonlySet<string>;
  foldTransitions: ReadonlyMap<string, number>;
  visibleEntries?: ConversationTimelineEntry[];
  start?: number;
}) {
  let latestActivityIndex = -1;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.kind === "user") break;
    if (entry.kind !== "agent") continue;
    // A reply row closes the activity lane. Without this guard an older
    // thinking row remains `working` after its answer has already rendered,
    // leaving the ASCII placeholder above the real response.
    const hasReply = entry.turn.blocks.some((block) =>
      (block.type === "text" && Boolean(block.content.trim())) || block.type === "media" ||
      block.type === "visualization" || block.type === "git_merge" ||
      block.type === "sub_session",
    );
    if (hasReply) break;
    if (entry.turn.blocks.some((block) =>
      block.type === "thinking" || block.type === "tool_call" || block.type === "tool_call_group",
    )) {
      latestActivityIndex = index;
      break;
    }
  }
  if (liveId) {
    let liveIndex = -1;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.kind === "agent" && entry.turn.stepId === liveId) {
        const hasReply = entry.turn.blocks.some((block) =>
          (block.type === "text" && Boolean(block.content.trim())) || block.type === "media" ||
          block.type === "visualization" || block.type === "git_merge" ||
          block.type === "sub_session",
        );
        if (hasReply) break;
        if (entry.turn.blocks.some((block) =>
          block.type === "thinking" || block.type === "tool_call" || block.type === "tool_call_group",
        )) {
          liveIndex = index;
          break;
        }
      }
    }
    if (liveIndex >= 0) latestActivityIndex = liveIndex;
  }
  // One placeholder closes the live step: the newest hidden reasoning segment
  // owns it when that segment is last, and the reply row borrows it when text
  // has already arrived. Both cases render exactly one shimmering row.
  let hiddenReasoningIndex = -1;
  if (hiddenReasoning && liveId) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.kind === "agent" && entry.turn.stepId === liveId) {
        hiddenReasoningIndex = index;
        break;
      }
    }
  }
  return visibleEntries.map((entry, visibleIndex) => {
    const index = start + visibleIndex;
    let isLiveEntry = false;
    if (liveEntryIds) {
      for (const stepId of liveEntryIds) {
        if (entry.id === stepId || entry.id.startsWith(`${stepId}:`)) {
          isLiveEntry = true;
          break;
        }
      }
    }
    const entryCacheVersion =
      isLiveEntry ||
      (Boolean(liveId) &&
        entry.kind === "agent" &&
        entry.turn.stepId === liveId)
        ? "live"
        : cacheVersion;
    return (
      <TimelineRow
        key={`${sessionId ?? "standalone"}:${entry.kind}-${entry.id}`}
        entry={entry}
        sessionId={sessionId}
        onExpandChild={onExpandChild}
        scrollRootRef={scrollRootRef}
        eager={eager}
        cacheVersion={entryCacheVersion}
        appended={appendedIds.has(entry.id)}
        foldFrom={foldTransitions.get(entry.id)}
        showsHiddenReasoning={index === hiddenReasoningIndex}
        isWorking={Boolean(streaming && index === latestActivityIndex)}
        isStreaming={Boolean(
          streaming &&
            entry.kind === "agent" &&
            entry.turn.status === "running" &&
            (liveId ? entry.turn.stepId === liveId : index === entries.length - 1),
        )}
      />
    );
  });
}

function TimelineRows({
  entries,
  liveId,
  sessionId,
  childSessions,
  streaming,
  onExpandChild,
  scrollRootRef,
  cacheVersion,
  liveEntryIds,
  liveSeed = EMPTY_LIVE_SEED,
  liveStartedAt = null,
  scopedConversation,
}: RowsProps) {
  const globalLive = useAgentSessionStore((s) =>
    !scopedConversation && liveId ? s.streamingLive : EMPTY_STREAMING_BUFFERS,
  );
  const scopedLive = useScopedConversationValue(scopedConversation, s => s.streamingLive);
  const live = scopedConversation ? scopedLive ?? EMPTY_STREAMING_BUFFERS : globalLive;
  const showThinking = useShellStore((s) => s.preferences.sessionShowThinking);
  // Hidden reasoning still needs one visible stand-in while the live step runs:
  // without it the transcript freezes as soon as no tool row or reply arrives.
  const hiddenReasoning = useMemo(() => {
    if (!liveId || !streaming || showThinking) return false;
    const blocks = [...liveSeed, ...materializeLiveBlocks(live)];
    if (
      blocks.some(
        (block) => block.type === "tool_call" || block.type === "tool_call_group",
      )
    )
      return false;
    return blocks.some(
      (block) => block.type === "thinking" && hasDisplayableReasoning(block.content),
    );
  }, [live, liveId, liveSeed, showThinking, streaming]);
  const combined = useMemo(() => {
    if (!liveId) return groupActivityEntries(entries);
    const rows = [...entries];
    const interactionIndex = rows.findIndex(
      (entry) =>
        entry.kind === "interaction" && entry.interaction.stepId === liveId,
    );
    // A live step never reaches the persisted timeline, so its delegation rows
    // get their cards here; without this the subagent stays an anonymous tool
    // line until the step is written to history.
    const liveBlocks = withSubagentCards(
      [...liveSeed, ...materializeLiveBlocks(live)],
      { parentSessionId: sessionId, childSessions, startedAt: liveStartedAt },
    );
    rows.splice(interactionIndex < 0 ? rows.length : interactionIndex, 0, {
      id: liveId,
      kind: "agent",
      createdAt: "",
      label: "",
      turn: {
        stepId: liveId,
        index: 0,
        status: "running",
        duration: null,
        completedAt: null,
        blocks: liveBlocks,
      },
    });
    return groupActivityEntries(rows);
  }, [
    entries,
    live,
    liveId,
    liveSeed,
    sessionId,
    childSessions,
    liveStartedAt,
  ]);
  // Appending a row reveals it; a history page or a folded round must not.
  const appendedIds = useAppendedEntryIds(combined, sessionId);
  // A fold that happens while this view is open contracts from the rows the
  // reader was already looking at; anything that arrives folded stays still.
  const foldTransitions = useFoldTransition(combined, sessionId);
  return <TimelineVirtualWindow
    key={sessionId ?? "standalone"}
    cacheKey={`${sessionId ?? "standalone"}:${cacheVersion}`}
    entries={combined}
    scrollRootRef={scrollRootRef}
    renderRows={(visibleEntries, start) => renderTimelineRows({
      entries: combined, visibleEntries, start, sessionId, streaming, liveId,
      onExpandChild, scrollRootRef, cacheVersion, liveEntryIds, appendedIds, hiddenReasoning, eager: true,
      foldTransitions,
    })}
  />;
}

export const SessionStaticTimeline = memo(function SessionStaticTimeline({
  unifiedLive = false,
  session,
  runs,
  steps,
  messages,
  toolCalls,
  childSessions,
  excludeStepId = null,
  isRunning = false,
  onExpandChild,
  scrollRootRef,
  scopedConversation,
}: Props) {
  const { t } = useLocale();
  const globalHistoryWindow = useAgentSessionStore(s => !scopedConversation && session ? s.sessionDetailCache[session.id]?.historyWindow : undefined);
  const scopedHistoryWindow = useScopedConversationValue(scopedConversation, s => s.history.historyWindow);
  const historyWindow = scopedConversation ? scopedHistoryWindow : globalHistoryWindow;
  const includeInitialPrompt = !historyWindow?.hasEarlier;
  const browsingHistory = historyWindow?.latest === false;

  const globalInteractions = useAgentSessionStore((s) =>
    !scopedConversation && s.interactionState?.sessionId === session?.id
      ? s.interactionState?.items
      : undefined,
  );
  const scopedInteractions = useScopedConversationValue(scopedConversation, s => s.interactions);
  const interactions = scopedConversation ? scopedInteractions : globalInteractions;
  const foldWorkRuns = useShellStore((s) => s.preferences.sessionFoldWorkRuns);
  const globalParkedSnapshots = useAgentSessionStore((s) =>
    !scopedConversation && unifiedLive && !browsingHistory ? s.streamingCompletedSteps : null,
  );
  const globalLiveId = useAgentSessionStore((s) =>
    !scopedConversation && unifiedLive && !browsingHistory ? s.streamingStepId : null,
  );
  const scopedParkedSnapshots = useScopedConversationValue(scopedConversation, s => s.streamingCompletedSteps);
  const scopedLiveId = useScopedConversationValue(scopedConversation, s => s.streamingStepId);
  const parkedSnapshots = scopedConversation ? scopedParkedSnapshots : globalParkedSnapshots;
  const liveId = scopedConversation ? scopedLiveId : globalLiveId;
  // History can reach this render before the store retires its parked row.
  // Keep a current live seed, but never let stale reasoning hide a saved reply.
  const snapshots = useMemo(
    () => parkedSnapshots?.filter(snapshot =>
      snapshot.stepId === liveId || !isLiveStepPersisted(snapshot, steps, messages, toolCalls),
    ) ?? null,
    [parkedSnapshots, liveId, steps, messages, toolCalls],
  );
  const showLive = Boolean(liveId && excludeStepId === liveId);
  const liveEntryIds = useMemo(
    () => new Set((snapshots ?? []).map((snapshot) => snapshot.stepId)),
    [snapshots],
  );
  const excludedStepIds = useMemo(
    () => (snapshots ?? []).map((snapshot) => snapshot.stepId),
    [snapshots],
  );
  const excludedRunIds = useMemo(() => {
    const runIds = new Set(
      (snapshots ?? [])
        .map((snapshot) => snapshot.runId)
        .filter((runId): runId is string => Boolean(runId)),
    );
    if (showLive && liveId) {
      const liveStep = steps.find((step) => step.id === liveId);
      if (liveStep?.runId) runIds.add(liveStep.runId);
    }
    return [...runIds];
  }, [snapshots, showLive, liveId, steps]);
  // Runtime writes increment revision too, so it must only invalidate height
  // measurements, never row identity. Remounting visible lazy rows hides their
  // contents until the next IntersectionObserver delivery (a transcript flash).
  // Epoch changes below still reset mounted state after a history rewrite.
  // Revision changes on ordinary runtime writes. It must not enter row keys or
  // lazy measurement keys, otherwise every persisted delta remounts the visible
  // transcript and IntersectionObserver briefly replaces it with a spacer.
  // Epoch changes represent a history rewrite and are safe to invalidate.
  const cacheVersion = historyWindow
    ? `epoch:${historyWindow.epoch ?? 0}`
    : "initial";
  const timeline = useMemo(() => {
    // A completed step can arrive before its assistant message. The store
    // retires each snapshot only after its persisted content is confirmed.
    const pendingSnapshots = (snapshots ?? []).filter(
      (snapshot) => snapshot.stepId !== liveId,
    );
    const snapshotIds = new Set(
      pendingSnapshots.map((snapshot) => snapshot.stepId),
    );
    const entries = buildConversationTimeline(
      runs,
      steps.filter((step) => !snapshotIds.has(step.id)),
      messages,
      toolCalls,
      childSessions,
      {
        excludeStepId,
        excludeStepIds: excludedStepIds,
        excludeRunIds: excludedRunIds,
        session,
        foldWorkRuns,
        includeInitialPrompt,
        interactions: browsingHistory ? undefined : interactions,
      },
    );
    for (const snapshot of pendingSnapshots) {
      const step = steps.find(step => step.id === snapshot.stepId);
      const run = runs.find(run => run.id === (snapshot.runId ?? step?.runId));
      const createdAt = step?.startedAt ?? snapshot.startedAt ?? run?.startedAt ?? "";
      const interactionIndex = entries.findIndex(
        (entry) =>
          entry.kind === "interaction" &&
          entry.interaction.stepId === snapshot.stepId,
      );
      const laterIndex = entries.findIndex(entry =>
        Date.parse(entry.createdAt) > Date.parse(createdAt),
      );
      entries.splice(
        interactionIndex >= 0 ? interactionIndex : laterIndex >= 0 ? laterIndex : entries.length,
        0,
        {
          id: snapshot.stepId,
          kind: "agent",
          createdAt,
          label: "",
          turn: {
            stepId: snapshot.stepId,
            index: snapshot.stepIndex,
            status: "completed",
            duration: null,
            // A live snapshot has no server completion time yet; the persisted
            // step replaces this row with its own stamp.
            completedAt: null,
            // A parked snapshot is the same live step, so its delegation row
            // keeps its card until the persisted step takes over.
            blocks: withSubagentCards(snapshot.blocks, {
              parentSessionId: session?.id,
              childSessions,
              startedAt: createdAt,
            }),
          },
        },
      );
    }
    // Pending requests, including plan approvals, belong to the composer;
    // retain only resolved history to avoid displaying the same form twice.
    // Filter after anchoring snapshots so tool activity keeps its original ordering.
    return entries.filter(
      (entry) =>
        entry.kind !== "interaction" ||
        entry.interaction.status !== "pending",
    );
  }, [
    runs,
    steps,
    messages,
    toolCalls,
    childSessions,
    excludeStepId,
    session,
    foldWorkRuns,
    includeInitialPrompt,
    browsingHistory,
    snapshots,
    liveId,
    excludedStepIds,
    excludedRunIds,
    interactions,
  ]);

  if (timeline.length === 0 && !showLive)
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-8">
        {isRunning ? (
          <>
            <Skeleton className="h-4 w-3/4 rounded-lg" />
            <Skeleton className="h-4 w-1/2 rounded-lg" />
            <Skeleton className="h-4 w-2/3 rounded-lg" />
          </>
        ) : (
          <span className="text-sm text-muted-foreground/50">
            {t("sessionNoRecords")}
          </span>
        )}
      </div>
    );
  return (
    <div className="flex flex-col gap-5">
      <TimelineRows
        scopedConversation={scopedConversation}
        entries={timeline}
        liveId={showLive ? liveId : null}
        streaming={isRunning}
        sessionId={session?.id}
        childSessions={childSessions}
        liveStartedAt={
          showLive && liveId
            ? steps.find((step) => step.id === liveId)?.startedAt ?? null
            : null
        }
        onExpandChild={onExpandChild}
        scrollRootRef={scrollRootRef}
        cacheVersion={cacheVersion}
        liveEntryIds={liveEntryIds}
        liveSeed={
          showLive
            ? snapshots?.find((snapshot) => snapshot.stepId === liveId)?.blocks
            : undefined
        }
      />
    </div>
  );
});
