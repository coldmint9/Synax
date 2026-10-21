import { lazy, Suspense, useState } from "react";
const HistoricalVisualizationReply = lazy(() => import("./HistoricalVisualizationReply"));
const InlineVisualization = lazy(() =>
  import("../visualizations/InlineVisualization").then((module) => ({
    default: module.InlineVisualization,
  })),
);
import type { InlineVisualizationReference } from "./visualizationTranscript";
import { MessageActionToolbar } from "./MessageActionToolbar";
import { useSessionHistory } from "./SessionHistoryContext";
import { useShellStore } from "../../shared/state/shellStore";
import { Zap } from "lucide-react";
import { useLocale } from "../../shared/hooks/useLocale";
import { hasDisplayableReasoning } from "./activityText";
import { ConversationActivityGroup } from "./ConversationActivityGroup";
import { MediaParts } from "../media/MediaParts";
import type {
  InterleavedTurn,
  TurnContentBlock,
} from "./buildInterleavedTurns";
import { StreamingTextBlock } from "./StreamingTextBlock";
import { SubSessionCard } from "./SubSessionCard";
import { ThinkingIndicator } from "./ThinkingIndicator";
import {
  buildTurnRenderSegments,
} from "./toolCallUtils";
import "./conversationFlow.css";

function TranscriptVisualization({
  reference,
}: {
  reference: InlineVisualizationReference;
}) {
  return (
    <Suspense
      fallback={
        <div className="text-[11px] text-muted-foreground" role="status">
          正在加载预览…
        </div>
      }
    >
      {reference.historyMessage
        ? <HistoricalVisualizationReply key={reference.id} message={reference.historyMessage} />
        : <InlineVisualization visualization={reference} />}
    </Suspense>
  );
}
function sourceLabel(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function segmentKey(
  segment: (ReturnType<typeof buildTurnRenderSegments>)[number],
  index: number,
): string {
  if (segment.type === "visualization") return `visualization:${segment.reference.id}`;
  if (segment.type === "media") return `media:${segment.messageId ?? index}`;
  if (segment.type === "sources")
    return `sources:${segment.sources.map((source) => source.id).join(",") || index}`;
  if (segment.type === "tool_round") {
    const ids = segment.toolBlocks.flatMap((block) =>
      block.type === "tool_call"
        ? [block.call.id]
        : block.type === "tool_call_group"
          ? block.calls.map((call) => call.id)
          : [],
    );
    // Appending a call must not remount the already-open rows in this round.
    return `tool-round:${ids[0] ?? index}`;
  }
  if (segment.type === "thinking") return `thinking:${index}`;
  if (segment.type === "text") return `text:${index}`;
  if (segment.type === "sub_session") return `sub-session:${segment.session.id}`;
  return `context-compacted:${index}`;
}

export function TurnContent({
  blocks,
  onExpandChild,
  rowKeyPrefix = "",
  isStreaming = false,
  isWorking = isStreaming,
  defaultExpanded,
}: {
  blocks: readonly TurnContentBlock[];
  onExpandChild?: (sessionId: string) => void;
  rowKeyPrefix?: string;
  isStreaming?: boolean;
  isWorking?: boolean;
  defaultExpanded?: boolean;
}) {
  const [appendReveal] = useState(isStreaming);
  const segments = buildTurnRenderSegments(blocks).filter(
    (segment) => segment.type !== "thinking" || hasDisplayableReasoning(segment.content),
  );
  const render = (segment: (typeof segments)[number], i: number) => {
    const key = segmentKey(segment, i);
    if (segment.type === "visualization")
      return (
        <TranscriptVisualization
          key={key}
          reference={segment.reference}
        />
      );
    if (segment.type === "media")
      return <MediaParts key={key} parts={segment.parts} />;
    if (segment.type === "text")
      return (
        <StreamingTextBlock
          key={key}
          text={segment.content}
          isStreaming={isStreaming && segment === segments[segments.length - 1]}
          markdown={segment.markdown}
        />
      );
    if (segment.type === "sources")
      return (
        <div key={key} className="mt-2 flex flex-wrap gap-1.5">
          {segment.sources.map((source, index) => (
            <a
              key={source.id}
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="max-w-full truncate rounded-md border border-default-200 px-2 py-1 text-[10px] text-primary hover:bg-default-100"
              title={source.title || source.url}
            >
              {index + 1}. {source.title || sourceLabel(source.url)}
            </a>
          ))}
        </div>
      );
    if (segment.type === "sub_session")
      return (
        <SubSessionCard
          key={key}
          session={segment.session}
          onExpand={onExpandChild}
        />
      );
    if (segment.type === "context_compacted")
      return (
        <div
          key={key}
          className="flex items-center gap-2 rounded-md border border-warning/20 bg-warning/5 px-3 py-1.5 text-[10px] text-warning"
        >
          <Zap size={12} />
          <span>
            上下文压缩: {segment.originalTokens.toLocaleString()} →{" "}
            {segment.compressedTokens.toLocaleString()} tokens (
            {segment.messageCount} 条消息被摘要)
          </span>
        </div>
      );
    return null;
  };
  // Commentary stays in the reading lane. Only adjacent thoughts and tools
  // share a disclosure, so folding an action never hides the text around it.
  const content = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const key = segmentKey(segment, index);
    if (segment.type === "thinking" || segment.type === "tool_round") {
      const activityBlocks: TurnContentBlock[] = [];
      while (index < segments.length) {
        const activity = segments[index];
        if (activity.type === "thinking") activityBlocks.push(activity);
        else if (activity.type === "tool_round") activityBlocks.push(...activity.toolBlocks);
        else break;
        index += 1;
      }
      const working = isWorking && index === segments.length;
      content.push(
        <ConversationActivityGroup
          key={key}
          blocks={activityBlocks}
          rememberKey={rowKeyPrefix ? `${rowKeyPrefix}:${key}` : undefined}
          working={working}
          streaming={isStreaming && working}
          defaultExpanded={defaultExpanded}
        />,
      );
      index -= 1;
      continue;
    }
    content.push(
      <div key={key} className="session-flow-entry session-answer-region">
        {render(segment, index)}
      </div>,
    );
  }
  return (
    <div className={appendReveal ? "session-conversation-flow session-flow-append" : "session-conversation-flow"}>
      <div className="session-flow-content">{content}</div>
    </div>
  );
}
/** One agent turn. Turn duration separators are intentionally omitted from the transcript. */
export function TurnBody({
  turn,
  entryId,
  onExpandChild,
  isStreaming = false,
  isWorking = isStreaming,
  showActions = true,
}: {
  turn: InterleavedTurn;
  entryId: string;
  onExpandChild?: (sessionId: string) => void;
  isStreaming?: boolean;
  isWorking?: boolean;
  /**
   * Whether this row is the round's final reply. Process rows leave the
   * copy / fork / rollback toolbar to that row instead of mounting an idle
   * placeholder under every step.
   */
  showActions?: boolean;
}) {
  const history = useSessionHistory();
  const { locale } = useLocale();
  const showThinking = useShellStore((state) => state.preferences.sessionShowThinking);
  const visibleBlocks = showThinking
    ? turn.blocks
    : turn.blocks.filter((block) => block.type !== "thinking");
  const textBlocks = turn.blocks.filter((block) => block.type === "text");
  const messageId =
    textBlocks[textBlocks.length - 1]?.messageId ??
    turn.blocks.find(
      (block) => block.type === "media" || block.type === "visualization",
    )?.messageId;
  const checkpoint = history?.checkpoint(messageId, turn.stepId);
  // The provider may still be loading persisted checkpoints while a response
  // is streaming. Keep the fork affordance available and let the request
  // resolve the stored checkpoint by message/step id after the user chooses a
  // workspace mode.
  const forkCheckpoint =
    checkpoint ??
    (history?.running && !isStreaming && (messageId || turn.stepId)
      ? {
          id: `message:${messageId ?? turn.stepId}`,
          kind: "reply" as const,
          messageId: messageId ?? "",
          stepId: turn.stepId ?? null,
          available: true,
          reason: null,
          hasLaterHistory: true,
          initialInput: false,
        }
      : undefined);
  const text = textBlocks.map((block) => block.content).join("\n\n");
  const hasAnswer = Boolean(
    text ||
    turn.blocks.some(
      (block) => block.type === "media" || block.type === "visualization",
    ),
  );
  return (
    <div className="session-turn-content message-action-group flex min-w-0 flex-1 flex-col gap-1">
      {isWorking && visibleBlocks.length === 0 ? (
        <ThinkingIndicator />
      ) : (
        <TurnContent blocks={visibleBlocks} onExpandChild={onExpandChild} rowKeyPrefix={entryId} isStreaming={isStreaming} isWorking={isWorking} />
      )}
      {hasAnswer && showActions && (
        <MessageActionToolbar
          role="assistant"
          text={text}
          timestamp={isStreaming ? null : turn.completedAt}
          disabledReason={history?.reason || checkpoint?.reason || undefined}
          forkDisabledReason={history?.forkReason || checkpoint?.reason || null}
          rollbackDisabled={
            checkpoint
              ? checkpoint.canRollback === false ||
                (!checkpoint.hasLaterHistory && !history?.running)
              : false
          }
          rollbackDisabledReason={
            checkpoint?.canRollback === false
              ? history?.reason || checkpoint.reason || (locale === "zh"
                ? "此消息没有可用的回滚检查点"
                : "No rollback checkpoint for this message")
              : undefined
          }
          busy={history?.busy}
          onFork={
            forkCheckpoint?.available
              ? (mode) => {
                  void history?.request("fork", forkCheckpoint, undefined, mode);
                }
              : undefined
          }
          onRollback={
            checkpoint?.available && checkpoint.canRollback !== false
              ? () => {
                  void history?.request("rollback", checkpoint);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
