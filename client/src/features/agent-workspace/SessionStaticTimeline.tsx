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
import {
  EMPTY_STREAMING_BUFFERS,
  materializeLiveBlocks,
} from "./streamingLiveBlocks";
import type { TurnContentBlock } from "./buildInterleavedTurns";
import { useAgentSessionStore } from "./state/agentSessionStore";
import { isLiveStepPersisted } from "./state/liveStepRetirement";
import { useShellStore } from "../../shared/state/shellStore";
import { useAppendedEntryIds } from "./useAppendedEntryIds";
import "./transcriptAppend.css";

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
}

type RowsProps = Pick<Props, "onExpandChild" | "scrollRootRef"> & {
  entries: ConversationTimelineEntry[];
  sessionId?: string;
  streaming?: boolean;
  liveId?: string | null;
  liveSeed?: readonly TurnContentBlock[];
  eager?: boolean;
  /** Version of cached height measurements, independent of React row identity. */
  cacheVersion?: string;
  /** Temporary live snapshots share the live height-cache namespace. */
  liveEntryIds?: ReadonlySet<string>;
};

type RowProps = Omit<RowsProps, "entries" | "streaming"> & {
  entry: ConversationTimelineEntry;
  isWorking: boolean;
  isStreaming: boolean;
  appended: boolean;
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
        previous.injected === next.injected &&
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
    eager,
    cacheVersion,
    appended,
  }: RowProps) {
    const key = `${sessionId ?? "standalone"}:${cacheVersion ?? "initial"}:${entry.kind}-${entry.id}`;
    return (
      <TimelineLazyEntry
        entryId={entry.id}
        cacheKey={key}
        estimate={estimateEntryHeight(entry)}
        scrollRootRef={scrollRootRef}
        eager={eager}
        appended={appended}
      >
        <TimelineEntryView
          entry={entry}
          onExpandChild={onExpandChild}
          isWorking={isWorking}
          isStreaming={isStreaming}
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
      previous.eager !== next.eager ||
      previous.cacheVersion !== next.cacheVersion
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
  visibleEntries = entries,
  start = 0,
}: RowsProps & { appendedIds: ReadonlySet<string>; visibleEntries?: ConversationTimelineEntry[]; start?: number }) {
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
  streaming,
  onExpandChild,
  scrollRootRef,
  cacheVersion,
  liveEntryIds,
  liveSeed = EMPTY_LIVE_SEED,
}: RowsProps) {
  const live = useAgentSessionStore((s) =>
    liveId ? s.streamingLive : EMPTY_STREAMING_BUFFERS,
  );
  const combined = useMemo(() => {
    if (!liveId) return groupActivityEntries(entries);
    const rows = [...entries];
    const interactionIndex = rows.findIndex(
      (entry) =>
        entry.kind === "interaction" && entry.interaction.stepId === liveId,
    );
    const liveBlocks = [
      ...liveSeed,
      ...materializeLiveBlocks(live),
    ];
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
  }, [entries, live, liveId, liveSeed]);
  // Appending a row reveals it; a history page or a folded round must not.
  const appendedIds = useAppendedEntryIds(combined, sessionId);
  return <TimelineVirtualWindow
    key={sessionId ?? "standalone"}
    cacheKey={`${sessionId ?? "standalone"}:${cacheVersion}`}
    entries={combined}
    scrollRootRef={scrollRootRef}
    renderRows={(visibleEntries, start) => renderTimelineRows({
      entries: combined, visibleEntries, start, sessionId, streaming, liveId,
      onExpandChild, scrollRootRef, cacheVersion, liveEntryIds, appendedIds, eager: true,
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
}: Props) {
  const { t } = useLocale();
  const historyWindow = useAgentSessionStore(s => session ? s.sessionDetailCache[session.id]?.historyWindow : undefined);
  const includeInitialPrompt = !historyWindow?.hasEarlier;
  const browsingHistory = historyWindow?.latest === false;

  const interactions = useAgentSessionStore((s) =>
    s.interactionState?.sessionId === session?.id
      ? s.interactionState?.items
      : undefined,
  );
  const foldWorkRuns = useShellStore((s) => s.preferences.sessionFoldWorkRuns);
  const parkedSnapshots = useAgentSessionStore((s) =>
    unifiedLive && !browsingHistory ? s.streamingCompletedSteps : null,
  );
  const liveId = useAgentSessionStore((s) =>
    unifiedLive && !browsingHistory ? s.streamingStepId : null,
  );
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
            blocks: snapshot.blocks,
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
        entries={timeline}
        liveId={showLive ? liveId : null}
        streaming={isRunning}
        sessionId={session?.id}
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
