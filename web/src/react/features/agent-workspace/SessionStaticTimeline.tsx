import { memo, useMemo, type RefObject } from "react";
import { shallow } from "zustand/shallow";
import { Skeleton } from "@heroui/react";
import { useLocale } from "../../../hooks/useLocale";
import type {
  AgentRun,
  AgentRunStep,
  AgentRuntimeMessage,
  AgentSession,
  ToolCallRecord,
} from "../../../lib/api/agentRuntime";
import {
  buildConversationTimeline,
  type ConversationTimelineEntry,
} from "./buildConversationTimeline";
import { TimelineEntryView } from "./TimelineEntryView";
import { TimelineLazyEntry, estimateEntryHeight } from "./TimelineLazyEntry";
import { groupActivityEntries } from "./groupActivityEntries";
import {
  EMPTY_STREAMING_BUFFERS,
  materializeLiveBlocks,
} from "./streamingLiveBlocks";
import { useAgentSessionStore } from "./state/agentSessionStore";
import { useShellStore } from "../../state/shellStore";

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
  eager?: boolean;
};

type RowProps = Omit<RowsProps, "entries" | "streaming"> & {
  entry: ConversationTimelineEntry;
  isWorking: boolean;
  isStreaming: boolean;
};

const TimelineRow = memo(
  function TimelineRow({
    entry,
    sessionId,
    onExpandChild,
    scrollRootRef,
    isWorking,
    isStreaming,
    eager,
  }: RowProps) {
    const key = `${sessionId ?? "standalone"}:${entry.kind}-${entry.id}`;
    return (
      <TimelineLazyEntry
        entryId={entry.id}
        cacheKey={key}
        estimate={estimateEntryHeight(entry)}
        scrollRootRef={scrollRootRef}
        eager={eager}
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
      previous.eager !== next.eager
    )
      return false;
    if (previous.entry === next.entry) return true;
    const a = previous.entry;
    const b = next.entry;
    if (a.kind !== "agent" || b.kind !== "agent" || a.id !== b.id) return false;
    // Grouping creates new arrays, but completed blocks retain their references.
    // Compare the rendered content so token deltas do not rebuild older answers.
    return (
      a.turn.blocks.length === b.turn.blocks.length &&
      a.turn.blocks.every((block, index) =>
        shallow(block, b.turn.blocks[index]),
      )
    );
  },
);

function renderTimelineRows({
  entries,
  sessionId,
  streaming,
  onExpandChild,
  scrollRootRef,
  eager,
}: RowsProps) {
  let latestActivityIndex = -1;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.kind === "user") break;
    if (
      entry.kind === "agent" &&
      entry.turn.blocks.some(
        (block) =>
          block.type === "thinking" ||
          block.type === "tool_call" ||
          block.type === "tool_call_group",
      )
    ) {
      latestActivityIndex = index;
      break;
    }
  }
  return entries.map((entry, index) => (
    <TimelineRow
      key={`${sessionId ?? "standalone"}:${entry.kind}-${entry.id}`}
      entry={entry}
      sessionId={sessionId}
      onExpandChild={onExpandChild}
      scrollRootRef={scrollRootRef}
      eager={eager}
      isWorking={Boolean(streaming && index === latestActivityIndex)}
      isStreaming={Boolean(
        streaming &&
        entry.kind === "agent" &&
        entry.turn.status === "running" &&
        index === entries.length - 1,
      )}
    />
  ));
}

/** Only the tail is rebuilt for tokens; all rows share one stable React parent. */
function TimelineRows({
  history,
  entries,
  liveId,
  sessionId,
  streaming,
  onExpandChild,
  scrollRootRef,
}: RowsProps & {
  history: ConversationTimelineEntry[];
  liveId: string | null;
}) {
  const live = useAgentSessionStore((s) =>
    liveId ? s.streamingLive : EMPTY_STREAMING_BUFFERS,
  );
  const historyRows = useMemo(
    () =>
      renderTimelineRows({
        entries: history,
        sessionId,
        streaming: streaming && !liveId,
        onExpandChild,
        scrollRootRef,
      }),
    [history, sessionId, streaming, liveId, onExpandChild, scrollRootRef],
  );
  const combined = useMemo(() => {
    if (!liveId) return groupActivityEntries(entries);
    const rows = [...entries];
    const interactionIndex = rows.findIndex(
      (entry) =>
        entry.kind === "interaction" && entry.interaction.stepId === liveId,
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
        blocks: materializeLiveBlocks(live),
      },
    });
    return groupActivityEntries(rows);
  }, [entries, live, liveId]);
  // Flatten the cached history and live rows into the SAME keyed sibling list.
  // Separate component/fragment parents remount every row at the live handoff,
  // resetting disclosure state and lazy height reservations (visible flashes).
  return (
    <>
      {[
        ...historyRows,
        ...renderTimelineRows({
          entries: combined,
          eager: Boolean(liveId),
          sessionId,
          streaming,
          onExpandChild,
          scrollRootRef,
        }),
      ]}
    </>
  );
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
  const interactions = useAgentSessionStore((s) =>
    s.interactionState?.sessionId === session?.id
      ? s.interactionState?.items
      : undefined,
  );
  const foldWorkRuns = useShellStore((s) => s.preferences.sessionFoldWorkRuns);
  const snapshots = useAgentSessionStore((s) =>
    unifiedLive ? s.streamingCompletedSteps : null,
  );
  const liveId = useAgentSessionStore((s) =>
    unifiedLive ? s.streamingStepId : null,
  );
  const showLive = Boolean(liveId && excludeStepId === liveId);
  const timeline = useMemo(() => {
    const persistedStepIds = new Set(
      steps.filter((step) => step.status !== "running").map((step) => step.id),
    );
    const pendingSnapshots = (snapshots ?? []).filter(
      (snapshot) => !persistedStepIds.has(snapshot.stepId),
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
        session,
        foldWorkRuns,
        interactions,
      },
    );
    for (const snapshot of pendingSnapshots) {
      const interactionIndex = entries.findIndex(
        (entry) =>
          entry.kind === "interaction" &&
          entry.interaction.stepId === snapshot.stepId,
      );
      entries.splice(
        interactionIndex < 0 ? entries.length : interactionIndex,
        0,
        {
          id: snapshot.stepId,
          kind: "agent",
          createdAt: "",
          label: "",
          turn: {
            stepId: snapshot.stepId,
            index: snapshot.stepIndex,
            status: "completed",
            duration: null,
            blocks: snapshot.blocks,
          },
        },
      );
    }
    return entries;
  }, [
    runs,
    steps,
    messages,
    toolCalls,
    childSessions,
    excludeStepId,
    session,
    foldWorkRuns,
    snapshots,
    interactions,
  ]);
  const { history, tail } = useMemo(() => {
    let boundary = timeline.length;
    if (showLive)
      while (boundary > 0) {
        const entry = timeline[boundary - 1];
        if (
          entry.kind !== "agent" &&
          !(entry.kind === "interaction" && entry.interaction.stepId === liveId)
        )
          break;
        boundary--;
      }
    return {
      history: groupActivityEntries(timeline.slice(0, boundary)),
      tail: timeline.slice(boundary),
    };
  }, [timeline, showLive, liveId]);

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
        history={history}
        entries={tail}
        liveId={showLive ? liveId : null}
        streaming={isRunning}
        sessionId={session?.id}
        onExpandChild={onExpandChild}
        scrollRootRef={scrollRootRef}
      />
    </div>
  );
});
